/**
 * SNOWTEX Cutting Dashboard - EDGE CACHE
 * =====================================================================
 * BUILD 26 Aug 2026
 *
 * Lives at  functions/api/eff.js  in the Dashboard repo, so Cloudflare
 * Pages compiles it and serves it at  /api/eff  on the same origin as the
 * dashboard. It deploys with the ordinary git push. There is no separate
 * Worker to publish and no wrangler to install.
 *
 * IMPORTANT: the functions/ directory is NOT served as static files. Pages
 * compiles it into a Worker. That is why the Apps Script URL below is safe
 * here and would not be safe in Dashboard/, where Cloudflare hands out
 * every file it finds.
 *
 * WHAT PROBLEM THIS SOLVES
 *   Eleven floors open the same report within the same few minutes. Without
 *   this, all eleven requests reach Apps Script, which serialises them on
 *   the same spreadsheet, so the eleventh leader waits for the other ten.
 *   With this, the first request warms the edge and the other ten are
 *   answered from Cloudflare in about a tenth of a second.
 *
 * THE FRESHNESS CONTRACT
 *   A read is served from the edge for up to TTL seconds. Past that it is
 *   still served instantly, and refreshed in the background, so nobody ever
 *   waits on a stale-but-present entry.
 *
 *   A WRITE is different. When a floor leader submits loss time the page
 *   sends fresh=1, which
 *     1. skips the cache entirely and goes to Apps Script,
 *     2. deletes the cached copy of that date, and
 *     3. writes the new answer back into the cache before replying.
 *   So the moment the submit returns, every other floor reading that date
 *   gets the corrected figures, not a five minute old copy. This is the
 *   part that matters: the cache never hides a correction.
 *
 * STORAGE
 *   Uses a KV namespace when one is bound as EFF_CACHE, because KV is
 *   global and a purge in Dhaka is a purge everywhere. Falls back to the
 *   built-in Cache API when it is not bound, which needs no setup at all
 *   but is per data centre. For eleven users in one building that is the
 *   same thing in practice.
 *
 *   To bind KV: Cloudflare dashboard > Workers & Pages > your Pages project
 *   > Settings > Functions > KV namespace bindings > Add, variable name
 *   EFF_CACHE. Nothing in this file changes.
 *
 * ENV VARS (all optional)
 *   EFF_API   the Apps Script /exec URL. Falls back to the constant below,
 *             so set it when the deployment URL changes and you would
 *             rather not touch code.
 *   EFF_TTL   seconds a read stays fresh before a background refresh.
 *             Default 300.
 */

const DEFAULT_API =
  'https://script.google.com/macros/s/AKfycbxQ2BmHNHGuMpy244VH_Tl2CwlB9Yu6HZUfg28XvqR4TWPcQowPQSMQuaNR27-wuSSP/exec';

const DEFAULT_TTL = 300;          // seconds a cached read is considered fresh
const HARD_TTL    = 86400;        // seconds before an entry is dropped outright
const FLOORS      = ['1A','1B','1C','1D','1E','3A','2A','2B','2C','2D','2E'];

/* The daily report loads SOL first, paints it, then loads SSL and merges it
   in, so the first table is on screen after one small payload. These names
   are duplicated in the Apps Script, which builds the same cache keys on its
   own side. Change one, change both. */
const FLOOR_GROUPS = {
  SOL: ['1A','1B','1C','1D','1E','3A'],
  SSL: ['2A','2B','2C','2D','2E']
};

/* Only these reach Apps Script. Anything else a browser sends is dropped, so
   a stray parameter cannot split the cache into a thousand near-identical
   entries or be used to make the origin do unexpected work. */
const ALLOWED = ['action','from','to','date','floor','floors','fresh','lossdate','lossfloor'];

const ACTIONS = ['snapshot','data','detail','purge','ping'];

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const p   = url.searchParams;

  const action = p.get('action') || 'snapshot';
  if (!ACTIONS.includes(action)) return json({ error: 'Unknown action' }, 400);

  const api = env.EFF_API || DEFAULT_API;
  const ttl = parseInt(env.EFF_TTL || '', 10) || DEFAULT_TTL;
  const store = makeStore(env);

  /* Build the upstream URL from the whitelist, in a fixed order, so that the
     same logical request always produces the same cache key no matter what
     order the browser happened to put the parameters in. */
  const up = new URL(api);
  for (const k of ALLOWED) {
    const v = p.get(k);
    if (v !== null && v !== '') up.searchParams.set(k, v);
  }

  const fresh = p.get('fresh') === '1';
  const key   = cacheKey(action, p);

  // ---- ping: never cached, never touches the sheet ----
  if (action === 'ping') {
    const r = await fetch(up.toString(), { cf: { cacheTtl: 0 } });
    return passthrough(r, 'PING');
  }

  // ---- purge: drop what this date can affect, then warm it back up ----
  if (action === 'purge') {
    const d = p.get('date') || '';
    await purge(store, d);
    if (d) context.waitUntil(warm(store, api, d));
    return json({ ok: true, purged: d || 'all' });
  }

  // ---- a write, or an explicit Refresh: bypass, then repopulate ----
  if (fresh) {
    const d = p.get('lossdate') || p.get('from') || p.get('date') || '';
    const r = await fetch(up.toString(), { cf: { cacheTtl: 0 } });
    const body = await r.text();

    /* Order matters. Purge FIRST so that a reader arriving mid-flight gets a
       miss and blocks on the origin, rather than being handed the copy this
       request is about to replace. Then write the new answer in. */
    context.waitUntil((async () => {
      await purge(store, d);
      if (r.ok && looksLikeJson(body)) {
        await store.put(key, body, HARD_TTL);
        /* A fresh snapshot also answers "the latest day", so seed that key
           and both progressive groups, and save the next reader a round trip
           to Google for rows that are already in hand. */
        if (action === 'snapshot') await seedFromSnapshot(store, body);
        if (action === 'data' && d) {
          try {
            const o = JSON.parse(body);
            if (Array.isArray(o.rows) && (p.get('to') || d) === d && !p.get('floors')) {
              await seedGroups(store, d, o.rows, o.generatedAt, o.v);
            }
          } catch (e) { }
        }
      }
    })());

    return respond(body, r.status, 'BYPASS');
  }

  // ---- a normal read ----
  const hit = await store.get(key);
  if (hit) {
    const age = Math.max(0, Math.floor(Date.now() / 1000) - hit.at);
    if (age > ttl) {
      /* Stale but present. Serve it now and refresh behind the reader's back,
         so nobody ever sits in front of a loading bar waiting for Google. */
      context.waitUntil(refresh(store, up.toString(), key));
      return respond(hit.body, 200, 'STALE', age);
    }
    return respond(hit.body, 200, 'HIT', age);
  }

  const r = await fetch(up.toString(), { cf: { cacheTtl: 0 } });
  const body = await r.text();
  if (r.ok && looksLikeJson(body)) {
    context.waitUntil(store.put(key, body, HARD_TTL));
  }
  return respond(body, r.status, 'MISS');
}

/* ------------------------------------------------------------------ keys */

function cacheKey(action, p) {
  if (action === 'data') {
    return dataKey(p.get('from') || '',
                   p.get('to') || p.get('from') || '',
                   floorsKey(p.get('floors')));
  }
  if (action === 'detail') return `v4:detail:${p.get('date') || ''}:${p.get('floor') || ''}`;
  return 'v4:snapshot';
}

function dataKey(from, to, fk) { return `v4:data:${from}:${to}:${fk || 'all'}`; }

/**
 * Normalise a floors parameter to the SAME key the Apps Script builds, so a
 * request for "3A,1A" and one for "1A,3A" are one cache entry rather than two.
 */
function floorsKey(csv) {
  const s = String(csv || '').trim();
  if (!s) return 'all';
  const named = FLOOR_GROUPS[s.toUpperCase()];
  const want = named || s.split(',').map(x => x.trim());
  const tabs = FLOORS.filter(t => want.includes(t));
  if (!tabs.length || tabs.length === FLOORS.length) return 'all';
  return tabs.slice().sort().join('.');
}

/** Every floor selection the dashboard can ask for: whole factory, and groups. */
function floorSets() {
  return ['all', ...Object.values(FLOOR_GROUPS).map(g => floorsKey(g.join(',')))];
}

/**
 * Everything a single date can appear in. A multi-day RANGE is deliberately
 * not here: there is no way to enumerate every from~to pair that contains a
 * given day, so ranges rely on the ordinary TTL instead.
 */
function keysForDate(d) {
  const out = ['v4:snapshot'];
  for (const fk of floorSets()) out.push(dataKey(d, d, fk));
  for (const f of FLOORS) out.push(`v4:detail:${d}:${f}`);
  return out;
}

async function purge(store, d) {
  const keys = d ? keysForDate(d) : ['v4:snapshot'];
  await store.del(keys);
}

/* ------------------------------------------------------------- warm/refresh */

async function refresh(store, upstream, key) {
  try {
    const r = await fetch(upstream, { cf: { cacheTtl: 0 } });
    const body = await r.text();
    if (r.ok && looksLikeJson(body)) await store.put(key, body, HARD_TTL);
  } catch (e) { /* a failed background refresh must never surface to a reader */ }
}

/**
 * Pull a date back into the cache after a purge, so the next reader gets a
 * hit rather than paying for the rebuild. One request for the whole factory,
 * then the two progressive groups are sliced out of that answer locally
 * instead of being fetched again.
 */
async function warm(store, api, d) {
  try {
    const u = new URL(api);
    u.searchParams.set('action', 'data');
    u.searchParams.set('from', d);
    u.searchParams.set('to', d);
    const r = await fetch(u.toString(), { cf: { cacheTtl: 0 } });
    const body = await r.text();
    if (!r.ok || !looksLikeJson(body)) return;
    await store.put(dataKey(d, d, 'all'), body, HARD_TTL);
    const o = JSON.parse(body);
    if (Array.isArray(o.rows)) await seedGroups(store, d, o.rows, o.generatedAt, o.v);
  } catch (e) { }
}

/** Slice a full day into the progressive groups and cache each one. */
async function seedGroups(store, date, rows, generatedAt, v) {
  for (const g of Object.keys(FLOOR_GROUPS)) {
    const set = FLOOR_GROUPS[g];
    const part = rows.filter(r => set.includes(r[0]));
    const payload = JSON.stringify({
      rows: part, floors: set, generatedAt, v, cached: true
    });
    await store.put(dataKey(date, date, floorsKey(set.join(','))), payload, HARD_TTL);
  }
}

/** A snapshot already contains the latest day's rows. Reuse them. */
async function seedFromSnapshot(store, body) {
  try {
    const o = JSON.parse(body);
    if (!o || !o.latest || !Array.isArray(o.rows)) return;
    const payload = JSON.stringify({
      rows: o.rows, floors: FLOORS, generatedAt: o.generatedAt, v: o.v, cached: true
    });
    await store.put(dataKey(o.latest, o.latest, 'all'), payload, HARD_TTL);
    await seedGroups(store, o.latest, o.rows, o.generatedAt, o.v);
  } catch (e) { }
}

/* ----------------------------------------------------------------- store */

/**
 * KV when it is bound, the built-in Cache API when it is not.
 * Both return { body, at } where `at` is a unix second stamp, which is what
 * the stale-while-revalidate decision is made on.
 */
function makeStore(env) {
  if (env.EFF_CACHE && typeof env.EFF_CACHE.get === 'function') {
    const kv = env.EFF_CACHE;
    return {
      async get(k) {
        const res = await kv.getWithMetadata(k, { type: 'text' });
        if (!res || res.value == null) return null;
        return { body: res.value, at: (res.metadata && res.metadata.at) || 0 };
      },
      put(k, body, ttl) {
        return kv.put(k, body, {
          expirationTtl: Math.max(60, ttl),
          metadata: { at: Math.floor(Date.now() / 1000) }
        });
      },
      async del(keys) { await Promise.all(keys.map(k => kv.delete(k))); }
    };
  }

  const cache = caches.default;
  const req = k => new Request('https://eff-cache.snowtex.internal/' + encodeURIComponent(k));
  return {
    async get(k) {
      const res = await cache.match(req(k));
      if (!res) return null;
      return { body: await res.text(), at: parseInt(res.headers.get('x-cached-at') || '0', 10) };
    },
    put(k, body, ttl) {
      return cache.put(req(k), new Response(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'max-age=' + Math.max(60, ttl),
          'x-cached-at': String(Math.floor(Date.now() / 1000))
        }
      }));
    },
    async del(keys) { await Promise.all(keys.map(k => cache.delete(req(k)))); }
  };
}

/* --------------------------------------------------------------- replies */

/** Apps Script answers an error page as HTML. Never cache that. */
function looksLikeJson(s) {
  const t = (s || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

function respond(body, status, state, age) {
  /* The UNCOMPRESSED byte count, stated explicitly.
     The dashboard draws its progress bar from bytes received against bytes
     expected. It cannot use content-length for that: when Cloudflare gzips a
     response, content-length is the COMPRESSED size while the browser hands
     the reader decompressed bytes, so the bar would sprint past 100% and
     then sit still. This header is the number the reader will actually
     count up to. */
  let bytes = 0;
  try { bytes = new TextEncoder().encode(body || '').length; } catch (e) { }

  return new Response(body, {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* The browser must not keep its own copy. Freshness is decided here,
         at the edge, where a purge can actually reach it. */
      'cache-control': 'no-store',
      'x-eff-cache': state,
      'x-eff-age': String(age == null ? 0 : age),
      'x-eff-bytes': String(bytes),
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-eff-cache, x-eff-age, x-eff-bytes'
    }
  });
}

function passthrough(r, state) {
  return r.text().then(t => respond(t, r.status, state));
}

function json(o, status) { return respond(JSON.stringify(o), status || 200, 'LOCAL'); }

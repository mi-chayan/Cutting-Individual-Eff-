/**
 * SNOWTEX Cutting Dashboard - EDGE CACHE for the other two APIs
 * =====================================================================
 * BUILD 26 Aug 2026
 *
 * Lives at  functions/api/[src].js  so Cloudflare Pages serves it at
 *   /api/pib   the Cutting Individual PIB script  (Weekly Individual report)
 *   /api/fab   the Fabric Roll Compliance script  (both compliance reports)
 *
 * /api/eff has its own file next to this one and takes precedence, because a
 * STATIC filename always beats a dynamic [src] segment in Pages routing. That
 * one needs date-aware purging so a loss-time submit is visible at once; these
 * two do not, so they get the simpler treatment below.
 *
 * WHY THESE TWO ARE DIFFERENT
 *   The efficiency sheet is written to all day, by eleven floor leaders
 *   entering loss time, so its cache has to be dropped by DATE on every write.
 *   These two are written once a day by a Python push and, for the PIB sheet,
 *   by a person pasting reviewed rows. Nothing a dashboard reader does changes
 *   them. So a plain time window plus stale-while-revalidate is the honest
 *   model here, and a purge by date would be machinery with nothing to do.
 *
 * WHAT IT BUYS
 *   Eleven leaders opening the same weekly report inside the same minute reach
 *   Apps Script ONCE instead of eleven times, and Apps Script serialises
 *   requests against one spreadsheet, so the eleventh was waiting for the other
 *   ten. Past the window an entry is still served instantly and refreshed
 *   behind the reader, so nobody ever waits on a stale-but-present answer.
 *
 * STORAGE
 *   KV when a namespace is bound as EFF_CACHE, because KV is global. The
 *   built-in Cache API otherwise, which needs no setup and is per data centre.
 *   For eleven users in one building that is the same thing in practice.
 *
 * ENV VARS (all optional)
 *   PIB_API, FAB_API   override the /exec URLs below
 *   EFF_TTL            seconds an entry stays fresh. Default 300.
 */

const UPSTREAM = {
  pib: 'https://script.google.com/macros/s/AKfycbyx4_1Oe3q03fWNEwIWWeicfSssI-g7TF1_sZrUFakWRsmSf8rGJXj1bHOJ6tS7w9_tDA/exec',
  fab: 'https://script.google.com/macros/s/AKfycbyUKWEap2AzQqsJ99nYAwj281xETRg7fIQJ2GWR6lQGOL6lM2FBQO0IFMUMSwdO0atz/exec'
};

/* Only these reach Apps Script. Anything else a browser sends is dropped, so a
   stray parameter cannot split the cache into a thousand near-identical
   entries or be used to make the origin do unexpected work. */
const ALLOWED = ['action', 'from', 'to', 'date', 'dates', 'floor', 'week', 'fresh'];

/* Actions each script actually answers. An unknown action is refused here
   rather than forwarded, so a typo costs nothing at the origin. */
const ACTIONS = {
  pib: ['snapshot', 'data'],
  fab: ['snapshot', 'data', 'detail', 'days', 'weekly', 'dates']
};

/* Some answers are worth holding much longer than others.
   A CLOSED day never changes again: the fabric roll rows for last Tuesday are
   whatever they were. The current day and the period list do change, so they
   get the short window. */
const LONG_ACTIONS = { detail: 1, days: 1 };

const DEFAULT_TTL = 300;      // seconds an entry is considered fresh
const LONG_TTL    = 21600;    // for answers about days that are already closed
const HARD_TTL    = 86400;    // seconds before an entry is dropped outright

/* How long this edge will wait on Apps Script before giving up on ITS OWN
   attempt. Not a limit on the report: when this expires the caller is told to
   go direct, and a browser will wait as long as the sheet needs.

   It exists because a proxy that hangs is worse than no proxy. Cloudflare will
   eventually kill the request and answer with its own HTML error page, and a
   page expecting JSON then dies on "<!DOCTYPE" with a message that explains
   nothing. Bounding the wait here means the failure is always OUR json. */
const UPSTREAM_MS = 20000;

/** fetch with a deadline. Rejects rather than hanging until Cloudflare does. */
async function fetchBounded(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || UPSTREAM_MS);
  try {
    return await fetch(url, { cf: { cacheTtl: 0 }, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const src = String(params.src || '').toLowerCase();

  if (!UPSTREAM[src]) {
    return json({ error: 'Unknown API: ' + src }, 404);
  }

  const url = new URL(request.url);
  const p = url.searchParams;
  const action = p.get('action') || 'snapshot';

  /* ANSWERED HERE, never forwarded.
     Every page probes this on open to decide whether the edge is deployed at
     all. Forwarding it would be wrong twice over: neither Apps Script has a
     ping action, and the PIB script treats a missing action as `snapshot`,
     which is its most expensive call. So the question "is the edge there"
     would have cost a full sheet read and then answered no. */
  if (action === 'ping') {
    return json({ ok: true, src: src, at: Date.now() });
  }

  if (!ACTIONS[src].includes(action)) {
    return json({ error: 'Unknown action: ' + action }, 400);
  }

  const api = env[src.toUpperCase() + '_API'] || UPSTREAM[src];
  const shortTtl = parseInt(env.EFF_TTL || '', 10) || DEFAULT_TTL;
  const ttl = LONG_ACTIONS[action] ? LONG_TTL : shortTtl;
  const store = makeStore(env);

  /* Build the upstream URL from the whitelist in a FIXED ORDER, so the same
     logical request always produces the same cache key no matter what order
     the browser happened to put the parameters in. */
  const up = new URL(api);
  const parts = [];
  for (const k of ALLOWED) {
    const v = p.get(k);
    if (v !== null && v !== '') {
      up.searchParams.set(k, v);
      if (k !== 'fresh') parts.push(k + '=' + v);
    }
  }
  const key = 'v1:' + src + ':' + parts.join('&');

  /* fresh=1 is the Refresh button. It must reach the sheet, and the answer it
     brings back becomes the new cached copy rather than being thrown away. */
  if (p.get('fresh') === '1') {
    try {
      const r = await fetchBounded(up.toString());
      const body = await r.text();
      if (r.ok && looksLikeJson(body)) {
        context.waitUntil(store.put(key, body, HARD_TTL));
        return respond(body, r.status, 'BYPASS');
      }
      return giveUp(context, store, up.toString(), key, null, 'BYPASS-FAIL');
    } catch (e) {
      /* A forced read is the Refresh button, so a stale copy is exactly what
         the user just said they did not want. Send them direct instead. */
      return giveUp(context, store, up.toString(), key, null, 'BYPASS-SLOW');
    }
  }

  const hit = await store.get(key);
  if (hit) {
    const age = Math.max(0, Math.floor(Date.now() / 1000) - hit.at);
    if (age > ttl) {
      /* Stale but present. Serve it NOW and refresh behind the reader, so
         nobody sits in front of a loading bar waiting for Google. */
      context.waitUntil(refresh(store, up.toString(), key));
      return respond(hit.body, 200, 'STALE', age);
    }
    return respond(hit.body, 200, 'HIT', age);
  }

  try {
    const r = await fetchBounded(up.toString());
    const body = await r.text();
    if (r.ok && looksLikeJson(body)) {
      context.waitUntil(store.put(key, body, HARD_TTL));
      return respond(body, r.status, 'MISS');
    }
    return giveUp(context, store, up.toString(), key, hit, 'MISS-FAIL');
  } catch (e) {
    return giveUp(context, store, up.toString(), key, hit, 'MISS-SLOW');
  }
}

/**
 * The upstream was too slow or answered with something that is not JSON.
 *
 * Serve a stale copy if there is one, because old figures beat no report. If
 * there is none, reply with JSON telling the page to ask Apps Script itself.
 * The status is 200 on purpose: the page must PARSE this, and a 5xx would send
 * it down the error path where it can do nothing useful.
 *
 * Either way the cache is warmed in the background, so this happens once and
 * the next reader gets a hit rather than the same wait.
 */
function giveUp(context, store, upstream, key, hit, state) {
  context.waitUntil(refresh(store, upstream, key));
  if (hit) return respond(hit.body, 200, state + '-STALE',
                          Math.max(0, Math.floor(Date.now() / 1000) - hit.at));
  return respond(JSON.stringify({
    ok: false,
    retryDirect: true,
    msg: 'The sheet is taking longer than this cache will wait. '
       + 'Reading it directly instead.'
  }), 200, state);
}

async function refresh(store, upstream, key) {
  try {
    /* Twice the foreground budget. Nobody is waiting on this one, and the
       whole point is to have an answer ready before the next reader arrives. */
    const r = await fetchBounded(upstream, UPSTREAM_MS * 2);
    const body = await r.text();
    if (r.ok && looksLikeJson(body)) await store.put(key, body, HARD_TTL);
  } catch (e) { /* a failed background refresh must never reach a reader */ }
}

/* ----------------------------------------------------------------- store */

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
      }
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
    }
  };
}

/* --------------------------------------------------------------- replies */

/** Apps Script answers an error as an HTML page. Never cache that. */
function looksLikeJson(s) {
  const t = (s || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

function respond(body, status, state, age) {
  /* The UNCOMPRESSED byte count, stated explicitly, so a page can draw a real
     progress bar from bytes received. content-length cannot be used for that:
     when Cloudflare gzips a response, content-length is the COMPRESSED size
     while the browser hands the reader decompressed bytes, so the bar would
     sprint past 100% and then sit still. */
  let bytes = 0;
  try { bytes = new TextEncoder().encode(body || '').length; } catch (e) { }

  return new Response(body, {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* The browser must not keep its own copy. Freshness is decided here, at
         the edge, where it can actually be replaced. */
      'cache-control': 'no-store',
      'x-eff-cache': state,
      'x-eff-age': String(age == null ? 0 : age),
      'x-eff-bytes': String(bytes),
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-eff-cache, x-eff-age, x-eff-bytes'
    }
  });
}

function json(o, status) { return respond(JSON.stringify(o), status || 200, 'LOCAL'); }

# SOSL Cutting Section Dashboard

One site, one menu, two completely separate reporting systems. They share
nothing except this shell and the image assets.

```
Dashboard/
  index.html            shell: header, burger menu, Refresh, iframe
  logo.jpg              shared assets, referenced as ../logo.jpg from a report
  favicon.ico
  apple-touch-icon.png

  efficiency/           EFFICIENCY SYSTEM
    daily.html          Daily Individual Eff% Report
    range.html          Weekly Individual Eff% Report (placeholder)

  compliance/           COMPLIANCE SYSTEM
    fabric.html         Fabric Roll Compliance Report
```

## The two systems

| | Efficiency | Compliance |
|---|---|---|
| Google Sheet | Cutting Individual Effi% _ | Fabric Comlpliance |
| Sheet ID | `1Yyxxu-9XVVsce-RyJeY8OXGXF-fXwCJ2aNXBMMPFmos` | `16ajV72TV2gZwtCakc08J9xmQW72U7JmGyGRWIryJ_Qg` |
| Pages | `efficiency/daily.html`, `efficiency/range.html` | `compliance/fabric.html` |
| Apps Script | `Cutting/Cutting Report Downloader/Code.gs` | `Fabric Roll Compliance/Fabric Roll Compliance Downloader/Code.gs` |
| Downloader | `download_cutting_individual_performance.py` | `download_fabric_roll_compliance.py` |
| Deployment var | `EFF_API` in index.html | `FAB_API` in index.html |
| sessionStorage | `sosl_snapshot_v1`, `sosl_day_*`, `sosl_det*` | `fabric_snapshot_v1`, `fabric_day_*`, `fabric_det_*` |

**The Apps Script files are not in this repo on purpose.** Each `Code.gs` lives
with the downloader that feeds the same sheet, so there is exactly one copy of
each and no chance of pasting the wrong one into the wrong spreadsheet.

## How Refresh works

`index.html` holds a `REPORTS` map. Refresh reads the entry for the tab
currently on screen, calls that system's `?action=snapshot&fresh=1`, parks the
result under that system's own sessionStorage key, clears only that system's
stale day and detail caches, then tells the iframe to redraw. Pressing Refresh
on the Compliance tab never touches Efficiency data, and the reverse.

## Adding a fourth report

1. Drop the html into `efficiency/` or `compliance/`.
2. Point its `favicon` at `../favicon.ico` and any `logo.jpg` at `../logo.jpg`.
3. Add one `<button class="mi" id="t_<name>">` to the menu in `index.html`.
4. Add one entry to `REPORTS` and one string to `TABS`.

Nothing else needs touching. `go()` loops over `TABS`, so the tab highlighting
picks the new report up on its own.

## After editing any Code.gs

Deploy -> Manage deployments -> pencil -> Version: **New version** -> Deploy.
Saving alone does nothing, the old version keeps serving. The `/exec` URL only
changes if you create a brand new deployment, and then it must be pasted into
`EFF_API` or `FAB_API` here, and into `WEBAPP_URL` in the matching
`push_to_sheets.py`.

(c) 2026 SNOWTEX CI Team | Help 2803

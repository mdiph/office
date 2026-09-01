# Applications monorepo

A small monorepo of internal web apps. The repository root is a **static launcher**
page (`index.html`) that lists the apps; each app lives in its own directory and is
fully self-contained.

```
/
├── index.html            # public static launcher (no auth, no backend) — links to each app
└── warehouse/            # App #1 — Warehouse Management
    ├── index.html            # single-page app (login → RBAC → dashboard)
    ├── config.js             # Apps Script web-app URL
    ├── css/ js/              # frontend (vanilla JS, ES modules, no framework, no build step)
    ├── js/vendor/           # Chart.js + SheetJS, vendored (no CDN)
    ├── apps-script/         # Google Apps Script backend — one Code.gs
    └── README.md            # full setup guide (Sheets, Drive, Apps Script, auth, GitHub Pages)
```

## Hosting on GitHub Pages

Enable **Settings → Pages → Deploy from a branch**, branch `main`, folder `/` (root).
The launcher is served at `https://<user>.github.io/<repo>/` and the warehouse app at
`https://<user>.github.io/<repo>/warehouse/`. All asset paths are relative, so no base-URL
configuration is required.

## Local development

```bash
# serve the static frontend (any static server works)
python3 -m http.server 8000
#  → launcher:  http://localhost:8000/
#  → warehouse: http://localhost:8000/warehouse/
```

The warehouse app needs its Google Apps Script backend deployed and its `/exec` URL
in `warehouse/config.js` — see [warehouse/README.md](warehouse/README.md) for the full
setup (Sheets, Drive, Apps Script, first admin).

## Adding another app

Create `newapp/` with its own `index.html` and assets, add a card to the root
`index.html`, and (if it needs a backend) give it its own Apps Script project + Sheet.
Shared frontend helpers can be factored into a top-level `shared/` folder at that point.

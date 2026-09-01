# Applications monorepo

A small monorepo of internal web apps. The repository root is a **static launcher**
page (`index.html`) that lists the apps; each app lives in its own directory and is
fully self-contained.

```
/
├── index.html            # public static launcher (no auth, no backend) — links to each app
├── DESIGN.md             # design decisions for the warehouse app
└── warehouse/            # App #1 — Warehouse Management
    ├── index.html            # single-page app (login → RBAC → dashboard)
    ├── config.js             # API mode switch (mock vs Apps Script)
    ├── css/ js/              # frontend (vanilla JS, ES modules, no framework, no build step)
    ├── js/vendor/           # Chart.js + SheetJS, vendored (no CDN)
    ├── apps-script/         # Google Apps Script backend (source of truth for the .gs files)
    ├── mock-server/         # zero-dependency Python mock backend for local development
    ├── README.md            # full setup guide (Sheets, Drive, Apps Script, auth, GitHub Pages)
    └── TESTING.md           # manual per-role test checklist
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

# in another terminal, run the mock backend so the warehouse app has data
python3 warehouse/mock-server/server.py
```

`warehouse/config.js` ships with `API_MODE: "mock"`. See
[warehouse/README.md](warehouse/README.md) to connect the real Google Apps Script backend.

## Adding another app

Create `newapp/` with its own `index.html` and assets, add a card to the root
`index.html`, and (if it needs a backend) give it its own Apps Script project + Sheet.
Shared frontend helpers can be factored into a top-level `shared/` folder at that point.

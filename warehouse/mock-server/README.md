# Mock backend

A single-file Python (standard library only) HTTP server that implements the **exact
same `{action, token, payload}` protocol** as the Google Apps Script backend, backed by
a local JSON file. It lets you develop and click through the entire warehouse app
offline — no Google account, no deployment.

It is deliberately thin: passwords are compared in plain text, there is no real locking
or crypto, and images are stored as data URLs. Business rules, RBAC, and the API shapes
match the real backend.

## Run

```bash
python3 server.py               # http://localhost:3000
python3 server.py --port 4000
python3 server.py --reset        # rebuild mock-db.json from mock-db.seed.json
```

Requires Python 3.8+. Nothing to install.

## Data

- `mock-db.seed.json` — pristine seed (committed).
- `mock-db.json` — working copy, created on first run, **gitignored**. Delete it or run
  `--reset` to start fresh.

## Seed logins

| Email | Password | Role |
|---|---|---|
| `admin@warehouse.local` | `admin123` | Admin |
| `staff@warehouse.local` | `staff123` | Warehouse Staff |
| `eng@warehouse.local`   | `eng123`   | Engineer |
| `view@warehouse.local`  | `view123`  | Viewer |

## Point the frontend at it

In `warehouse/config.js`:

```js
API_MODE: "mock",
MOCK_API_URL: "http://localhost:3000",
```

## CORS

The server sends `Access-Control-Allow-Origin: *` and answers `OPTIONS`, so the frontend
served from `http://localhost:8000` can call it directly.

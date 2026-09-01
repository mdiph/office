# Warehouse Management

A responsive warehouse management web app: inventory, receiving, issuing, borrowing,
returns, item history, dashboards, reports/exports and audit logging with role-based
access control.

- **Frontend:** HTML + CSS + vanilla JavaScript (ES modules, no framework, no build step).
- **Backend:** Google Apps Script web app.
- **Database:** Google Sheets. **Images:** Google Drive.
- **Hosting:** GitHub Pages (frontend) + Apps Script deployment (backend).
- **Vendored libraries** (committed, no CDN): Chart.js, SheetJS.

---

## 1. Architecture

```
 Browser (GitHub Pages)                 Google
┌───────────────────────────┐          ┌──────────────────────────────┐
│  warehouse/index.html     │          │  Apps Script Web App (doPost) │
│  ├─ js/app.js  (router)   │  POST    │  ├─ auth + sessions          │
│  ├─ js/api.js  ───────────┼─────────►│  ├─ RBAC (per action)        │
│  ├─ js/views/*            │  JSON    │  ├─ LockService writes       │
│  └─ js/vendor/ (Chart,    │◄─────────┤  ├─ Sheets (data)            │
│      SheetJS)             │          │  └─ Drive (photos)           │
└───────────────────────────┘          └──────────────────────────────┘
        │  API_MODE = "mock"
        └──────────────► warehouse/mock-server/server.py  (local dev only)
```

- One `doPost(e)` entry point routes `{action, token, payload}`.
- Requests use `Content-Type: text/plain` (avoids the CORS preflight Apps Script can't answer). The token travels in the body, never a header.
- Every response is HTTP 200 with `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
- The **append-only `Transactions` sheet is the source of truth**; `Units.status` and
  `Inventory.quantityOnHand` are caches written in the same lock and rebuildable via
  `recomputeFromLedger()`.

---

## 2. Prerequisites

| Need | For |
|---|---|
| A Google account | Sheets, Drive, Apps Script |
| Python 3.8+ | serving the frontend locally, running the mock backend |
| Node.js + `npm i -g @google/clasp` | pushing `.gs` files (optional — you can copy-paste instead) |

---

## 3. Local development first (no Google needed)

```bash
# from the repo root
python3 -m http.server 8000                       # serves the frontend
python3 warehouse/mock-server/server.py           # serves the mock backend (port 3000)
```

Open **http://localhost:8000/warehouse/** and sign in with `admin@warehouse.local` /
`admin123` (see `mock-server/README.md` for all seed logins). `config.js` already has
`API_MODE: "mock"`.

Everything works against the mock: RBAC, borrow/return, image capture (stored as data
URLs), reports, audit log. When you're happy, wire up the real backend below.

> **Webcam capture:** the "Use webcam" button on the photo field only works on a
> **secure context** — `http://localhost` / `http://127.0.0.1`, or any HTTPS URL
> (GitHub Pages qualifies). If you open the app via a LAN IP (`http://192.168.…`)
> the browser blocks camera access; use "Take / choose photo" there. The button now
> explains this if you click it in a blocked context.

---

## 4. Google Sheets

1. Create a new Google Sheet (any name). Leave it empty — `setup()` creates the tabs.
2. Copy its **ID** from the URL: `https://docs.google.com/spreadsheets/d/`**`<THIS>`**`/edit`.
3. (Optional, for tests) create a **second** sheet and note its ID too.

Tabs created by `setup()`: `Users`, `Sessions`, `Inventory`, `Units`, `Transactions`,
`AuditLog`, `Config`, `Categories`, `Locations`, `Counters`.

---

## 5. Google Drive

1. Create a folder for product photos (e.g. "Warehouse Photos").
2. Copy its **ID** from the URL: `https://drive.google.com/drive/folders/`**`<THIS>`**.

Uploaded photos are set to *anyone-with-link can view* so `<img>` tags work for every
user — treat product photos as effectively public. A daily trigger trashes images no
sheet row references.

---

## 6. Apps Script backend

### 6a. Create the project

**Option A — clasp (keeps the repo as source of truth):**

```bash
npm i -g @google/clasp
clasp login
cd warehouse/apps-script
clasp create --type webapp --title "Warehouse Backend"   # writes .clasp.json
clasp push
```

**Option B — manual:** create a project at <https://script.google.com>, then create one
file per `.gs` in `warehouse/apps-script/` and paste the contents. Also set the project
manifest (`appsscript.json`) via Project Settings → "Show appsscript.json".

### 6b. Script properties

Project Settings → **Script properties** → add:

| Key | Value |
|---|---|
| `SPREADSHEET_ID` | the Sheet ID from step 4 |
| `DRIVE_FOLDER_ID` | the Drive folder ID from step 5 |
| `PASSWORD_PEPPER` | a long random string — **keep secret, never commit** |
| `BOOTSTRAP_ADMIN_EMAIL` | your email (becomes the first Admin) |
| `BOOTSTRAP_ADMIN_PASSWORD` | a strong temporary password (deleted by `setup()`) |
| `HASH_ITERATIONS` | *(optional)* default `50000`; lower if logins feel slow |
| `TEST_SPREADSHEET_ID` | *(optional)* the second Sheet, for `runAllTests()` |

### 6c. Run setup

In the editor, run **`setup()`** once and grant the permission prompts. It:

- creates all tabs with headers,
- seeds `Config`, `Categories`, `Locations`,
- creates the bootstrap Admin and **deletes `BOOTSTRAP_ADMIN_PASSWORD`**,
- installs time triggers (`purgeSessions` every 6h, `sweepOrphanImages` daily),
- writes `schemaVersion`.

### 6d. Deploy

**Deploy → New deployment → Web app**

- Execute as: **Me**
- Who has access: **Anyone**

Copy the **Web app URL** (ends in `/exec`). The endpoint is world-reachable by design;
every action still checks the session token and role.

### 6e. Optional: demo data

Run `seedDemoData()` for a few sample SKUs. **Never run it on a production sheet.**

---

## 7. Point the frontend at the backend

Edit `warehouse/config.js`:

```js
export const CONFIG = {
  API_MODE: "prod",
  GAS_WEB_APP_URL: "https://script.google.com/macros/s/AKfycb..../exec",
  ...
};
```

Reload the app and sign in with the bootstrap admin.

---

## 8. GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Deploy from a branch →** branch `main`, folder `/` (root).
3. Frontend is live at `https://<user>.github.io/<repo>/warehouse/`.

No build step. If you later use a custom domain, nothing changes (paths are relative).

---

## 9. Roles & permissions

Backend-enforced on every action (`CAPS` in `apps-script/Config.gs`). The frontend also
hides nav items by role, but that is cosmetic only.

| Action | Admin | Warehouse Staff | Engineer | Viewer |
|---|:-:|:-:|:-:|:-:|
| View dashboard / inventory / reports / borrowed / history | ✅ | ✅ | ✅ | ✅ |
| Export data (CSV / Excel / print) | ✅ | ✅ | ✅ | ❌ |
| Receive · add/edit SKU & units · issue · process returns · clear inspection | ✅ | ✅ | ❌ | ❌ |
| Create a borrow (for self) | ✅ | ✅ | ✅ | ❌ |
| Record a borrow on behalf of someone else | ✅ | ✅ | ❌ | ❌ |
| Manage users & roles | ✅ | ❌ | ❌ | ❌ |
| View / export the audit log | ✅ | ❌ | ❌ | ❌ |
| Delete transactions | — nobody — | | | |

Items are **soft-deleted** (archived) only, and only when no stock or open transactions
remain. `trackingType` cannot change once any transaction exists.

**Categories & locations** are managed on the **Settings** page (Admin): add, rename
(cascades to existing items / units), or delete (blocked while anything still references
them). You can also edit the `Categories` / `Locations` tabs of the Sheet directly.

---

## 10. User management

- **Create user:** Users page → *Add user*. Admin sets the password directly (min 8
  chars). No temp-password / forced-change flow.
- **Forgot password:** an Admin uses *Reset pw* on the Users page. There is no email.
- **Force logout:** ends all of that user's sessions immediately.
- **Disable:** uncheck *Account active* — also ends their sessions.
- **First admin:** created by `setup()` from the bootstrap script properties.

---

## 11. Backup & maintenance

| Task | How |
|---|---|
| Backup | File → Make a copy of the Sheet; the Drive folder holds the photos. |
| Rebuild status/quantity caches | Run `recomputeFromLedger()` in the Apps Script editor. |
| Schema version | `Config!schemaVersion` must equal `SCHEMA_VERSION` in `Config.gs`; a mismatch makes the backend refuse requests until you re-run `setup()`. |
| Archive old audit rows | The log is append-only. To trim, copy `AuditLog` to a dated sheet and delete old rows manually. |
| Triggers | `purgeSessions` (6h) and `sweepOrphanImages` (daily) are installed by `setup()`; check Triggers in the editor. |
| Run backend tests | Set `TEST_SPREADSHEET_ID`, run `runAllTests()`, read the log. |

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Cannot reach the server" | Wrong `GAS_WEB_APP_URL`, or the deployment isn't "Anyone". Re-deploy. |
| Every call returns `SCHEMA` error | `Config!schemaVersion` ≠ code. Re-run `setup()`. |
| "Session expired" immediately after login | Server/client clock skew, or the `Sessions` tab headers are wrong. Re-run `setup()`. |
| Images upload but don't display | The Drive file sharing didn't apply; open the folder and set "Anyone with the link – Viewer". |
| Login is slow (2–3 s) | Lower `HASH_ITERATIONS` (e.g. `20000`) and have users reset passwords, or accept it. |
| CORS error in console | You added a custom header or `application/json` content-type somewhere — the client must send `text/plain`. |
| clasp `push` fails | `clasp login` again; ensure the Apps Script API is enabled at <https://script.google.com/home/usersettings>. |

---

## 13. Security notes & known limitations

- The Apps Script endpoint is **world-reachable**; protection is the per-request session
  token + role check. Keep `PASSWORD_PEPPER` secret.
- **Product photos are effectively public** to anyone with the Drive file ID.
- The session token lives in `localStorage` (XSS exposure). The app loads no third-party
  runtime scripts beyond the vendored Chart.js / SheetJS.
- Password hashing is PBKDF2-style iterated HMAC-SHA256, not bcrypt/argon2 — weaker per
  guess. Mitigated by admin-set strong passwords, a secret pepper, a locked-down Sheet,
  and a 5-attempt / 15-minute lockout.
- No offline support, no real-time multi-user sync (lists refresh after your own writes
  and on the manual refresh button).
- `xlsx` (SheetJS) and Chart.js are third-party code vendored into `js/vendor/`.

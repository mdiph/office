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
| Python 3 (or any static server) | serving the frontend locally |

---

## 3. Order of setup

The frontend is useless without the backend, so do it in this order:

1. **Google Sheet + Apps Script** (§4) — create the Sheet, add the script, run `setup()`.
2. **Deploy** (§5) — deploy as a Web app, copy the `/exec` URL.
3. **Point the frontend at it** (§6) — paste the URL into `config.js`.
4. Serve the frontend and sign in as the admin:

   ```bash
   python3 -m http.server 8000     # → http://localhost:8000/warehouse/
   ```

The app starts empty — one admin user, no items. In the app: **Settings** → add your
Categories and Locations, then **Receive** to bring in stock.

> **Webcam capture:** the "Use webcam" button on the photo field only works on a
> **secure context** — `http://localhost` / `http://127.0.0.1`, or any HTTPS URL
> (GitHub Pages qualifies). If you open the app via a LAN IP (`http://192.168.…`)
> the browser blocks camera access; use "Take / choose photo" there. The button now
> explains this if you click it in a blocked context.

---

## 4. Google Sheet + Apps Script backend

1. Create a new Google Sheet (any name). Leave it empty — `setup()` builds the tabs.
2. **File → Settings → Time zone** — set it to your location (all date math uses this).
3. **Extensions → Apps Script.** This opens a script **bound to that Sheet** (which is
   why no Sheet ID is needed anywhere).
4. Select everything in the default `Code.gs`, delete it, and paste in the whole of
   **`warehouse/apps-script/Code.gs`**. Save.
5. *(optional)* At the top of the file, edit the config constants —
   `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (your first login) and
   `PHOTO_FOLDER_NAME`. The defaults work fine.
6. Function dropdown → **`setup`** → **Run**. Grant the permission prompts. It:
   - builds all tabs (`Users`, `Sessions`, `Inventory`, `Units`, `Transactions`,
     `AuditLog`, `Config`, `Categories`, `Locations`, `Counters`),
   - generates the password secret and stores it in the `Config` tab,
   - creates the one Admin from the constants above — no other users, no sample data,
   - installs triggers (`purgeSessions` 6h, `sweepOrphanImages` daily).
7. *(optional)* Run **`runAllTests`** to verify — it works on a throwaway Sheet it
   deletes afterward, and never touches your data.

Product photos go to a Drive folder named `PHOTO_FOLDER_NAME` (created automatically,
`anyone-with-link` viewable so `<img>` tags load) — treat them as effectively public.

> **No Script Properties, no manifest to edit.** Apps Script runs V8 and requests the
> Sheets/Drive/trigger permissions on the first `setup()` run.

---

## 5. Deploy

**Deploy → New deployment → Web app**

- Execute as: **Me**
- Who has access: **Anyone**

Copy the **Web app URL** (ends in `/exec`). The endpoint is world-reachable by design;
every action still checks the session token and role.

To ship a code change later: paste the new `Code.gs`, then **Deploy → Manage
deployments → edit → Version: New**.

---

## 6. Point the frontend at the backend

Edit `warehouse/config.js`:

```js
export const CONFIG = {
  GAS_WEB_APP_URL: "https://script.google.com/macros/s/AKfycb..../exec",
  ...
};
```

Reload the app and sign in as the Admin — then **change that password immediately**
(Settings → change password, or the Users page).

---

## 7. GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Deploy from a branch →** branch `main`, folder `/` (root).
3. Frontend is live at `https://<user>.github.io/<repo>/warehouse/`.

No build step. If you later use a custom domain, nothing changes (paths are relative).

---

## 8. Roles & permissions

Backend-enforced on every action (`CAPS`, in the Config section of `apps-script/Code.gs`). The frontend also
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

## 9. User management

- **Create user:** Users page → *Add user*. Admin sets the password directly (min 8
  chars). No temp-password / forced-change flow.
- **Forgot password:** an Admin uses *Reset pw* on the Users page. There is no email.
- **Force logout:** ends all of that user's sessions immediately.
- **Disable:** uncheck *Account active* — also ends their sessions.
- **First admin:** created by `setup()` from the `BOOTSTRAP_ADMIN_*` constants at the
  top of `Code.gs`. Change the password right after the first sign-in.

---

## 10. Backup & maintenance

| Task | How |
|---|---|
| Backup | File → Make a copy of the Sheet; the Drive folder holds the photos. |
| Rebuild status/quantity caches | Run `recomputeFromLedger()` in the Apps Script editor. |
| Schema version | `Config!schemaVersion` must equal `SCHEMA_VERSION` in `Code.gs`; a mismatch makes the backend refuse requests until you re-run `setup()`. |
| Archive old audit rows | The log is append-only. To trim, copy `AuditLog` to a dated sheet and delete old rows manually. |
| Triggers | `purgeSessions` (6h) and `sweepOrphanImages` (daily) are installed by `setup()`; check Triggers in the editor. |
| Run backend tests | Run `runAllTests()` in the editor (uses a throwaway Sheet), read the log. |
| Password hash speed | Edit `HASH_ITERATIONS` at the top of `Code.gs` (lower = faster logins, e.g. `20000`); existing hashes keep working. |

---

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Cannot reach the server" | Wrong `GAS_WEB_APP_URL`, or the deployment isn't "Anyone". Re-deploy. |
| `CONFIG` / "No bound spreadsheet" error | The script wasn't created from **Extensions → Apps Script** inside the Sheet. Recreate it there. |
| `CONFIG` / "run setup()" | You deployed before running `setup()`. Run it from the editor. |
| Every call returns `SCHEMA` error | `Config!schemaVersion` ≠ code. Re-run `setup()`. |
| "Session expired" immediately after login | Server/client clock skew, or the `Sessions` tab headers are wrong. Re-run `setup()`. |
| Images upload but don't display | The Drive file sharing didn't apply; open the folder and set "Anyone with the link – Viewer". |
| Login is slow (2–3 s) | Lower `HASH_ITERATIONS` at the top of `Code.gs`. |
| CORS error in console | You added a custom header or `application/json` content-type somewhere — the client must send `text/plain`. |

---

## 12. Security notes & known limitations

- The Apps Script endpoint is **world-reachable**; protection is the per-request session
  token + role check.
- The password secret is generated by `setup()` and lives in the `Config` tab of the
  Sheet — never in the code and never sent to a client. It stays put; don't edit it.
- **Product photos are effectively public** to anyone with the Drive file ID.
- The session token lives in `localStorage` (XSS exposure). The app loads no third-party
  runtime scripts beyond the vendored Chart.js / SheetJS.
- Password hashing is PBKDF2-style iterated HMAC-SHA256, not bcrypt/argon2 — weaker per
  guess. Mitigated by admin-set strong passwords, the per-install secret, a locked-down
  Sheet, and a 5-attempt / 15-minute lockout.
- No offline support, no real-time multi-user sync (lists refresh after your own writes
  and on the manual refresh button).
- `xlsx` (SheetJS) and Chart.js are third-party code vendored into `js/vendor/`.

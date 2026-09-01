# Warehouse Management App — Design Decisions

Agreed design from the grill-me session. This is the build contract for v1.

## 0. Repo shape (monorepo — Q1/C, Q2/B, revised)

Root holds **only** the static launcher. Everything warehouse-related — including the
mock server, API client, and design tokens — lives under `/warehouse/`.

```
/
├── index.html            # self-contained public launcher (inline CSS), links to apps. No auth, no backend.
├── README.md             # repo overview + monorepo layout (conventional; not part of "the page")
└── warehouse/            # first app (SPA) — fully self-contained
    ├── index.html
    ├── config.js         # GAS web-app URL + API_BASE switch (mock vs prod)
    ├── css/              # tokens.css, app.css, components.css, print.css
    ├── js/
    │   ├── app.js        # bootstrap + hash router (#/dashboard, #/inventory, ...)
    │   ├── api.js        # fetch wrapper for the {action,token,payload} protocol
    │   ├── auth.js       # login, session, role gate
    │   ├── store.js      # in-memory cache, write-through invalidation
    │   ├── views/        # dashboard.js, inventory.js, receive.js, issue.js,
    │   │                 #   borrow.js, borrowed.js, returns.js, history.js,
    │   │                 #   reports.js, audit.js, users.js, settings.js
    │   ├── components/   # modal.js, table.js, toast.js, confirm.js, chart.js
    │   ├── util/         # dates.js, csv.js, xlsx.js, dom.js, escape.js, icons.js
    │   └── vendor/       # chart.umd.min.js, xlsx (SheetJS) — pinned, committed
    ├── apps-script/      # Code.gs + split .gs files + appsscript.json (source of truth)
    ├── mock-server/
    │   ├── server.py     # Python stdlib http.server, zero deps, same API protocol
    │   ├── mock-db.json  # seeded demo data
    │   └── README.md
    ├── README.md         # full setup guide (13 sections)
    └── TESTING.md        # per-role manual click-through checklist
```

- **Root `index.html`** is one self-contained file with inline `<style>` — a header and a
  grid of app cards (one card: Warehouse Management → `warehouse/index.html`). No shared
  stylesheet, no JS, no backend calls.
- **No `/shared/` directory.** The warehouse app owns its own `api.js` and `tokens.css`.
  When a second app is added, extract shared bits then (YAGNI now).
- One GAS project + one Spreadsheet **per app** (warehouse gets its own). No shared backend.

## 1. Auth (Q3/B, Q4/A, Q5, Q6)

- **Custom username/password.** No Google Sign-In.
- **Hashing:** per-user 16-byte random salt + server-side pepper (Script Property), iterated HMAC-SHA256 (PBKDF2-style), iterations tuned so login ≈ 1.5 s (~10k–50k). Stored as `salt:iterations:hash` in `Users`.
- **Sessions:** GAS issues opaque 32-byte hex token. `Sessions` sheet: `token, userEmail, createdAt, lastSeenAt, expiresAt, userAgent`. **Sliding expiry: 8 h idle / 24 h absolute.** Token in `localStorage`. Daily time-trigger purges expired rows.
- **User provisioning:** Admin creates users in-app (name, email, role) and **sets the password directly** (no temp-password mechanism). No forced change; users may change their own password from Settings.
- **Forgot password:** admin-reset only, no email.
- **Lockout:** 5 failed attempts → 15-min lock (`failedCount`, `lockedUntil` on the `Users` row).
- **Bootstrap:** `setup()` reads `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` Script Properties, creates the first Admin, clears the password property.

## 2. Data model (Q7/A, Q8/A, Q9/A)

Sheets (tabs) in one Spreadsheet:
`Users`, `Sessions`, `Inventory` (SKUs), `Units` (serialized physical units), `Transactions`, `AuditLog`, `Config`, `Categories`, `Locations`, `Counters`.

- **Two-table inventory:** `Inventory` = one row per SKU (`itemCode`, name, category, brand, model, spec, description, photo fileId, `trackingType` = serialized|quantity, `quantityOnHand` for quantity-type, `active`). `Units` = one row per serialized physical unit (`unitId`, `itemCode`, `serialNumber` nullable, `condition`, `status`, `location`, `currentHolder`, `photo` optional).
- **Single append-only `Transactions` ledger** — the source of truth. Row: `txnId (uuid), slipNo, timestamp, txnDate (user-set), type (RECEIVE|ISSUE|BORROW|RETURN|ADJUST), itemCode, unitId?, qty, qtyDamaged?, fromLocation, toLocation, party, employeeId, department, project, purpose, destination, expectedReturnDate, actualReturnDate, condition, requiresInspection, notes, processedBy, linkedTxnId`. Never overwritten.
- **Status & quantity are atomically-written caches** — GAS updates `Units.status` / `Inventory.quantityOnHand` in the same LockService block as the ledger append. Admin **"recompute from ledger"** button replays the ledger to rebuild all state.

## 3. RBAC (Q11) — backend-enforced on every action

| Action | Admin | Whse Staff | Engineer | Viewer |
|---|:-:|:-:|:-:|:-:|
| View dashboard / inventory / reports | ✅ | ✅ | ✅ | ✅ |
| Export data | ✅ | ✅ | ✅ | ❌ |
| Receive / add-edit SKU & units / issue / process returns | ✅ | ✅ | ❌ | ❌ |
| Create a borrow | ✅ | ✅ | ✅ (self, processedBy = self) | ❌ |
| Record borrow on behalf of others | ✅ | ✅ | ❌ | ❌ |
| Manage users & roles | ✅ | ❌ | ❌ | ❌ |
| View / export audit log | ✅ | ❌ | ❌ | ❌ |
| Delete transactions | ❌ nobody | ❌ | ❌ | ❌ |

- **Soft-delete only** (`active = FALSE`); hard delete never. Blocked while stock on hand or open transactions exist.
- Nav options hidden by role in the frontend; server still enforces.

## 4. GAS mechanics (Q10, Q15)

- Single `doPost(e)` — parse `e.postData.contents` as JSON `{action, token, payload}`, route to handlers, uniform auth/RBAC/audit middleware. `doGet` = health check only.
- **CORS:** `fetch` with `Content-Type: text/plain;charset=utf-8`, token in body (no `Authorization` header), no preflight. `ContentService` JSON response, always HTTP 200 with `{ok, data}` or `{ok:false, error:{code,message}}`.
- Deployed **"Execute as: Me", "Who has access: Anyone"** — world-reachable, protected only by app-level token+role checks (accepted).
- **Concurrency:** every write wraps `LockService.getScriptLock()` (10–30 s). Re-check preconditions (unit status, quantity) **inside** the lock. Reads don't lock.
- Ledger/audit via `appendRow()`. Batch reads with `getDataRange().getValues()`; `CacheService` short-TTL for `Config`/`Users`.
- **Secrets/infra in Script Properties:** Sheet ID, Drive folder ID, pepper, iteration count, session TTLs. **Business tuning in `Config` sheet:** low-stock threshold, overdue grace days, schema version.
- **`schemaVersion` guard** on every request — refuse if the sheet is behind.
- Deploy via **clasp** (`clasp push`), manual copy-paste as fallback.

## 5. Images (Q12)

- Capture: `<input type="file" accept="image/*" capture="environment">`.
- Client downscales to ≤1600px, JPEG ~0.8 via `<canvas>` (mandatory).
- Base64 in JSON POST → GAS `Utilities.base64Decode` → `folder.createFile(blob)`.
- Store **Drive file ID** in Sheets. Render via `https://drive.google.com/thumbnail?id=<ID>&sz=w400`.
- Files set "anyone with link can view" — **product photos are effectively public** (accepted).
- Upload first (returns ID), then submit form with the ID. Periodic trigger sweeps orphans.
- One photo per SKU + one optional photo per serialized unit. Replaceable (new file, ID updated, old swept); not versioned.

## 6. Vocabularies (Q22)

- **Status** (fixed enum): `Available`, `Borrowed`, `Issued-out`, `Under inspection`, `Maintenance`, `Retired`, `Lost`.
- **Condition** (fixed enum): `New`, `Good`, `Fair`, `Damaged`, `Needs repair`, `Incomplete`.
- **Category:** Admin-managed `Categories` tab (no on-the-fly add), seeded with starters. Settings page supports add / rename (cascades to `Inventory`) / delete (blocked while in use).
- **Brand / Model:** free text with `<datalist>` autocomplete from existing values.
- **Location:** Admin-managed `Locations` tab of codes (`A-01`, `STAGING`, `QUARANTINE`, ...). One `location` field per item/unit. Settings page supports add / rename (cascades to `Units`) / delete (blocked while units are stored there).

## 7. Business rules (Q23) — all strict, server-enforced

- Borrow a serialized unit not `Available` → reject. No reservations/queue.
- Issue/borrow quantity > `quantityOnHand` → reject. No negative stock, no backorder.
- Precondition re-check happens **inside** the write lock.
- Return more than outstanding → reject (good + damaged ≤ outstanding borrowed qty).
- `trackingType` change → blocked entirely once any transaction exists. Other SKU fields editable anytime.
- Soft-delete blocked while stock > 0 or open transactions.
- Borrow **requires** `expectedReturnDate`. Issue may omit it (permanent issue — leaves inventory, never overdue).
- User-set transaction date allowed (defaults now); audit timestamp is always real server time.

## 8. Transaction flows

- **Receive (Q28e):** two modes — "New item" (creates SKU) and "Restock existing" (pick SKU, add qty / register more units). Records `processedBy` + timestamp automatically.
- **Issue:** item, recipient, department, destination, purpose, date, expected return (optional), processedBy. The Issue page also lists everything **currently issued out** (serialized units with status `Issued-out` + quantity issues that carry an expected-return date and haven't come back), overdue highlighted. This list is viewable by all roles; the issue form is Staff/Admin only.
- **Inventory is edit-only:** new items and additional stock are created exclusively through **Receive** (so every stock change has a ledger entry). The Inventory list and item-detail pages allow editing the SKU and individual units, archiving, and clearing inspection — no "Add item" / "Add units".
- **Borrow:** borrower name, employee ID, department, item, unit/serial, qty, purpose, project/site, borrow date, **expected return date (required)**, processedBy (auto = current user). Sets unit status → `Borrowed`.
- **Returns (Q18):** close a specific borrow. Records return date, returnedBy, receivedBy (auto = current user), condition dropdown, "requires inspection" checkbox (auto-checks when condition ≠ Good, manually overridable), damage/missing, notes. Not flagged → immediate flip to `Available`. Flagged → status `Under inspection`; separate `clearInspection` action (Staff/Admin) → `Available` / `Maintenance` / `Retired`. Quantity items: "qty returned good" + "qty damaged/missing"; good → `quantityOnHand`, damaged → write-off note.
- **Borrowed Items page:** open borrows, overdue highlighted.
- **Item History:** unified timeline filtered by `itemCode` / `unitId`, sorted by time.

## 9. Dashboard (Q16) & charts (Q17, Q30)

- One on-demand `getDashboard` action computes everything in GAS; `CacheService` 60–120 s TTL.
- Tiles: **SKUs** (distinct active `Inventory`), **Total units/stock** (active `Units` + Σ `quantityOnHand`), Available, Borrowed, Outside warehouse (Borrowed + returnable Issues), Overdue, Low-stock, plus **Recent transactions** (last 10, "view all" link).
- **No price/value field anywhere.**
- Overdue = open BORROW or returnable ISSUE where `expectedReturnDate + graceDays < today` (grace default 0, date-only, Spreadsheet TZ).
- Charts (**Chart.js vendored locally**, `js/vendor/`, pinned): (1) inventory by category bar, (2) 30-day activity by type, (3) stock-status doughnut. GAS pre-shapes the arrays. Graceful degradation if the script fails.

## 10. Tables (Q20)

- Hybrid filtering: Inventory/Units/Users/Borrowed → full list to client, filter in JS. Transactions/AuditLog → server-side paginated with filters (date range, type, user, item); date range **required** for audit & transactions.
- 50 rows, "Load more" (row-offset cursor).
- `store.js` caches per session; re-fetch after any write the user performs + manual refresh button. **No polling.**
- Inventory search: case-insensitive substring across item code, name, brand, model, serial, category, location; AND-combined with dropdown filters (category, status, location, condition).

## 11. Reports & export (Q19)

- **Client-side generation.** Existing list/export actions supply data.
- **Real `.xlsx` via vendored SheetJS** (`js/vendor/`, community edition) + CSV (with UTF-8 BOM) alongside.
- Reports: inventory, incoming, outgoing, borrowed, overdue, transaction history, audit logs.
- Full filtered export, 50k-row hard cap, date-range required for audit/transactions.
- PDF = `@media print` stylesheet + "Print" button → `window.print()` → browser "Save as PDF". Applies to item history sheet, borrowed list, overdue list.
- All exports gated on `Export data` permission; audit-log export Admin-only.

## 12. Audit log (Q21)

- Logged: every mutating action + login/logout + failed login + every export + **denied attempts** (`result = denied`). Not logged: pure reads.
- Row: `auditId (uuid), timestamp, userEmail, role, action, targetType, targetId, summary, userAgent, result (success|denied|error)`. Summary = short human string, **no field-level diffs**. No IP.
- **Best-effort:** written after the business action succeeds; audit-append failure never rolls back or blocks the action.
- Retention unbounded (append-only). Manual archive procedure in README.

## 13. UX states (Q24)

- `toast.js`: success (green, 3 s auto), error (red, manual), info.
- Loading: per-view skeleton/spinner; **buttons disable + inline spinner on submit** (double-submit guard).
- `api.js` normalizes network failure / `ok:false` / malformed → thrown `ApiError`; views catch → toast.
- `error.code === 'AUTH_EXPIRED'` → clear localStorage, redirect to login with notice, preserve intended hash for post-login return.
- `confirm.js` modal (not `window.confirm`) for soft-delete, force-logout, role change, clear-inspection.
- Total backend failure → persistent "Cannot reach server — retrying" banner, writes disabled. **No offline queue, no service worker.**

## 14. Responsive (Q29) — desktop-first

- ≥1024px persistent sidebar; 768–1023px collapsible; <768px hamburger drawer (minimal JS toggle).
- Dense tables (transactions, audit) → horizontal scroll container. Primary lists (inventory, borrowed) → stacked card layout <768px.
- Floor flows excellent on phone: Receive (camera), Borrow, Return, inventory lookup. Reports/admin/users desktop-oriented.

## 15. Visual identity (Q30)

- Palette: slate/charcoal sidebar, white content, **accent utility blue `#2563EB`** for primary actions; semantic green/red/amber for status.
- **Light theme only for v1**; CSS custom properties structured so dark can be added later.
- System font stack, no web fonts. Compact/dense (14px base, tight rows).
- Icons: one inline SVG sprite (~15 icons).

## 16. Local development (Q26, "test locally first")

- **Frontend:** `python3 -m http.server 8000` from repo root. `/` = launcher, `/warehouse/` = app.
- **Backend for local dev:** `warehouse/mock-server/server.py` (Python stdlib only, zero deps) implements the exact `{action,token,payload}` protocol against `mock-db.json` (seeded). Thin — no real auth crypto, no locking; matches request/response shapes only.
- `config.js` switch: `API_BASE` → `localhost:3000` (mock) vs GAS URL (prod).
- Mock stores uploaded images as data URLs.
- Doubles as living API documentation.

## 17. First-run / setup (Q25)

- Operator manually creates the Spreadsheet and Drive folder, pastes IDs into Script Properties.
- `setup()` (run once from GAS editor): creates tabs + headers, seeds `Config`/`Categories`/`Locations`, creates bootstrap Admin from Script Properties then clears the password, writes `schemaVersion`.
- `seedDemoData()` — separate, never auto-run, ~20 SKUs + units + transactions; README warns against prod use.
- Triggers to install: daily session purge, orphan-image sweep.

## 18. Testing (Q26)

- **`Tests.gs`:** hand-rolled `runAllTests()` with assert helpers, run from editor against a **separate test Spreadsheet** (own Script Property). Covers hash/verify, session lifecycle, RBAC table, borrow→return transitions, over-issue rejection, ledger→status recompute.
- **`warehouse/tests.html`:** in-browser assertions for pure utils (dates, csv, escapeHtml, overdue calc).
- **`warehouse/TESTING.md`:** scripted per-role click-through.
- CI: at most a GitHub Action running `node --check` on JS + HTML validation. No deploy automation.

## 19. Build plan (Q32)

- **Mock-backed first** (milestones 1–12), then port every action to real GAS (13), then integration pass (14).
- **Delivered as one big push** (not milestone-by-milestone).
- **All 11 features in v1** (interdependent).

Order: scaffold → mock backend → auth e2e → inventory → receive → borrow/borrowed/return → issue → item history → dashboard+charts → reports/export → audit log → user management → real GAS port → integration → polish → docs.

## Known limitations (document in README)

- GAS endpoint is world-reachable (app-token protected).
- Drive product images are effectively public via file ID.
- Session token in `localStorage` (XSS exposure; mitigated by no third-party runtime scripts beyond vendored Chart.js/SheetJS).
- Lower hash iteration count than bcrypt — compensated by admin-set strong passwords + locked-down Sheet.
- No offline support. No real-time multi-user sync (manual refresh).
- xlsx/Chart.js are vendored third-party code in the repo.

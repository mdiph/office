# Manual test checklist

Run before pushing changes. Works against the mock backend
(`python3 mock-server/server.py` + `python3 -m http.server 8000`, open
`http://localhost:8000/warehouse/`). Run `python3 mock-server/server.py --reset` first
for a clean slate.

## Automated (run these first)

- [ ] `http://localhost:8000/warehouse/tests.html` → **ALL PASSED** (pure util tests).
- [ ] Backend: set `TEST_SPREADSHEET_ID`, run `runAllTests()` in the Apps Script editor → **ALL PASSED** (only when testing the real backend).

## Auth & RBAC

- [ ] Sign in as `admin@warehouse.local / admin123`. Dashboard loads with tiles + 3 charts.
- [ ] Sign out. Sign in as `view@warehouse.local / view123`.
- [ ] Viewer sidebar shows **only** Dashboard, Inventory, Borrowed Items, Item History, Reports, Settings (no Receive/Issue/Borrow/Returns/Users/Audit).
- [ ] As Viewer, visiting `#/receive` shows "You do not have access to this page."
- [ ] As Viewer, Reports page: running any report is refused / no export buttons where disallowed.
- [ ] Sign in as `eng@warehouse.local / eng123`. Borrow page is available; borrower name is locked to the engineer.
- [ ] 5 bad passwords in a row → account locks for ~15 min ("Account locked").

## Inventory

- [ ] Search "drill" filters the table; category / status / location / type filters combine.
- [ ] Click an item code → detail page with photo placeholder, units table, history timeline.
- [ ] As Staff: **Add item** (serialized) → appears in list.
- [ ] Add units to it → units table grows, unit IDs increment (`-U01`, `-U02`).
- [ ] Edit the SKU (name/spec) → persists after reload.
- [ ] Try to archive an item that has units → blocked message.

## Receive

- [ ] **New item / quantity**: create, set qty + location → dashboard "Total stock" rises.
- [ ] **New item / serialized**: choose 2 units with locations → 2 units created.
- [ ] **Restock existing / quantity**: add 10 → quantity on hand increases by 10.
- [ ] Photo: "Take / choose photo" → pick an image → thumbnail appears, item saves with it.

## Borrow → Borrowed Items → Return

- [ ] Borrow a serialized unit (due date required) → success toast; unit status = Borrowed.
- [ ] Borrowed Items page lists it; set the due date in the past via a new borrow → row highlighted red + "Overdue".
- [ ] Returns page → *Process return* → condition **Good**, no inspection → unit back to Available.
- [ ] Borrow again, return with condition **Damaged** → "requires inspection" auto-checks → unit status = Under inspection.
- [ ] Item detail → unit row → **Clear inspection** → choose Available → status updates.
- [ ] Quantity borrow of 5, return 3 good + 1 damaged → outstanding = 1; quantity on hand rose by 3 only.
- [ ] Try to return more than outstanding → blocked.

## Issue

- [ ] Issue a serialized unit with an expected return date → unit status = Issued-out; appears in dashboard "Outside warehouse".
- [ ] Issue quantity stock with no return date → quantity drops, not counted as overdue.

## Item History

- [ ] Pick an item → timeline shows RECEIVE → BORROW → RETURN in order; "All events" table + CSV + Print work.

## Reports & Export

- [ ] Each report button renders a table.
- [ ] CSV downloads and opens in a spreadsheet with correct columns.
- [ ] Excel downloads a real `.xlsx` (SheetJS present) — or a `.csv` fallback if not.
- [ ] Print opens a clean print view.
- [ ] Audit report requires a date range; Viewer/Staff cannot run it.

## Audit Log (Admin)

- [ ] Set a date range, Run → rows for your logins, receives, borrows, returns, exports.
- [ ] A denied action (e.g. from a prior Viewer test) shows with a red "denied" result.
- [ ] CSV / Excel export works.

## Users (Admin)

- [ ] Add a user (role Engineer, password ≥ 8) → can sign in.
- [ ] Reset that user's password → old password fails, new works.
- [ ] Force logout → their next action bounces to the login screen with "session expired".
- [ ] Disable the user → cannot sign in.

## Settings

- [ ] Change low-stock threshold → dashboard "Low stock" tile recalculates on reload.
- [ ] Add a category / location → appears in the relevant dropdowns.
- [ ] Change own password from Settings → sign out / in with the new one.

## Responsive

- [ ] Narrow the window < 900px → sidebar collapses to a hamburger drawer.
- [ ] < 720px → Inventory / Borrowed lists switch to stacked cards; dense tables scroll horizontally.
- [ ] On a phone, Receive → photo field opens the rear camera.

## Resilience

- [ ] Stop the mock server mid-session → red "Cannot reach the server" banner; it clears when the server is back.

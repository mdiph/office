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
- [ ] Viewer sidebar shows **only** Dashboard, Inventory, Issue / Outgoing, Borrowed Items, Item History, Reports, Settings (no Receive/Borrow/Users/Audit; Issue page shows the list but not the form).
- [ ] As Viewer, visiting `#/receive` shows "You do not have access to this page."
- [ ] As Viewer, Reports page: running any report is refused / no export buttons where disallowed.
- [ ] Sign in as `eng@warehouse.local / eng123`. Borrow page is available; borrower name is locked to the engineer.
- [ ] 5 bad passwords in a row → account locks for ~15 min ("Account locked").

## Inventory (edit-only)

- [ ] Search "drill" filters the table; category / status / location / type filters combine.
- [ ] There is **no "Add item"** button — only "Receive stock" which links to Receive.
- [ ] Click an item code → detail page with photo placeholder, units table, history timeline.
- [ ] Item detail has **Edit** (SKU) and per-unit **Edit**, plus **Archive** — but **no "Add units"** ("Receive more" links to Receive instead).
- [ ] Edit the SKU (name/spec) → persists after reload.
- [ ] Edit a unit's condition/location → persists.
- [ ] Try to archive an item that has units → blocked message.

## Receive

- [ ] **New item / quantity**: create, set qty + location → dashboard "Total stock" rises.
- [ ] **New item / serialized**: choose 2 units with locations → 2 units created.
- [ ] **Restock existing / quantity**: add 10 → quantity on hand increases by 10.
- [ ] Photo: "Take / choose photo" → pick an image → thumbnail appears, item saves with it.

## Borrow → Borrowed Items → Return

- [ ] Borrow a serialized unit (due date required) → success toast; unit status = Borrowed.
- [ ] Borrowed Items page lists it; set the due date in the past via a new borrow → row highlighted red + "Overdue".
- [ ] Borrowed Items → row's **Return** button → *Process return* → condition **Good**, no inspection → unit back to Available.
- [ ] Borrow again, Return with condition **Damaged** → "requires inspection" auto-checks → unit status = Under inspection.
- [ ] Item detail → unit row → **Clear inspection** → choose Available → status updates.
- [ ] Quantity borrow of 5, return 3 good + 1 damaged → outstanding = 1; quantity on hand rose by 3 only.
- [ ] Try to return more than outstanding → blocked.

## Issue / Outgoing

- [ ] Page opens with a **"Currently issued out"** table (serialized units at status Issued-out + quantity issues with an expected return still out).
- [ ] Issue a serialized unit with an expected return date → it appears in that table; overdue ones are highlighted red.
- [ ] Issue a unit with **no** return date → shows in the table with a "permanent" badge.
- [ ] Issue quantity stock with an expected return → shows as `×N`; with no return date it isn't listed (it's just gone).
- [ ] Search box filters the list by item / recipient / dept.
- [ ] Print / CSV / Excel act on the issued list.
- [ ] As a Viewer/Engineer: the page and list are visible, but the "Record an issue" form is hidden.

## Item History

- [ ] Opens showing **all** transactions across every item (no selection needed), newest first, with "Load more".
- [ ] Type filter (RECEIVE/ISSUE/BORROW/RETURN/ADJUST) narrows the list.
- [ ] Pick an item → list narrows to that item **and** a Timeline card appears (RECEIVE → BORROW → RETURN in order). Pick a unit → narrows further.
- [ ] Clear the item filter → back to overall history.
- [ ] **Print** → browser print dialog shows the table (not a blank page); CSV downloads the current rows.

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
- [ ] Rename a location that units use → confirm; units keep working and now show the new code.
- [ ] Delete an unused category/location → gone. Delete one still in use → blocked with a count.
- [ ] Change own password from Settings → sign out / in with the new one.

## Responsive

- [ ] Narrow the window < 900px → sidebar collapses to a hamburger drawer.
- [ ] < 720px → Inventory / Borrowed lists switch to stacked cards; dense tables scroll horizontally.
- [ ] On a phone, Receive → photo field opens the rear camera.

## Resilience

- [ ] Stop the mock server mid-session → red "Cannot reach the server" banner; it clears when the server is back.

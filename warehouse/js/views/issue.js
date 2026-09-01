import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getInventory, invalidateInventory, can, currentUser, skuName } from "../store.js";
import { pageHead, card, btn, withBusy } from "./_shared.js";
import { dataTable } from "../components/table.js";
import { buildForm } from "../components/form.js";
import { itemUnitPicker } from "./_picker.js";
import { toastOk, toastErr } from "../components/toast.js";
import { todayISO, addDaysISO, fmtDateTime } from "../util/dates.js";
import { exportCSV, exportXLSX, printSection } from "../util/export.js";

// Outgoing items are always one of two things:
//   - a PERMANENT issue (sold to a customer, consumed, handed off for good) — no
//     return date, a serialized unit is removed from inventory entirely.
//   - a LOAN (borrow) — expected back by a date, tracked on Borrowed Items with
//     overdue highlighting and a Return button there.
// This page lets you record either, and shows a log of recent permanent issues.
export async function viewIssue() {
  const { skus, units } = await getInventory(true);
  const me = currentUser();
  const canIssue = can("issue");
  const canBorrowSelf = can("borrow_self");
  const canBorrowBehalf = can("borrow_behalf");

  const formSection = (canIssue || canBorrowSelf)
    ? buildOutgoingForm({ skus, units, me, canIssue, canBorrowBehalf })
    : null;

  const recentCard = await buildRecentIssuesCard();

  return h("div.stack", [
    pageHead("Issue / Outgoing", []),
    formSection,
    recentCard,
  ]);
}

function buildOutgoingForm({ skus, units, me, canIssue, canBorrowBehalf }) {
  const showModeChoice = canIssue; // Engineer-only visitors can just borrow — no choice to show
  const modeSel = h("select", [
    h("option", { value: "permanent", text: "Permanent — sold to a customer, consumed, etc." }),
    h("option", { value: "loan", text: "Loan / borrow — expected back by a date" }),
  ]);

  const picker = itemUnitPicker({ skus, units, availableOnly: true });
  const fieldsHost = h("div");
  const save = h("button.btn.btn--primary");

  function mode() { return showModeChoice ? modeSel.value : "loan"; }

  function render() {
    fieldsHost.innerHTML = "";
    if (mode() === "permanent") fieldsHost.appendChild(permanentFields());
    else fieldsHost.appendChild(loanFields());
  }

  let permanentForm = null;
  function permanentFields() {
    permanentForm = buildForm([
      { name: "recipient", label: "Recipient", required: true },
      { name: "department", label: "Department", required: true },
      { name: "destination", label: "Destination" },
      { name: "purpose", label: "Purpose", required: true, full: true },
      { name: "txnDate", label: "Issue date", type: "date", value: todayISO(), required: true },
    ]);
    save.textContent = "Issue permanently";
    return h("div.stack", [
      h("div.muted", { style: "font-size:.82rem", text:
        "The item leaves inventory for good. A serialized unit is removed entirely — only the transaction history keeps the record (with its serial number)." }),
      permanentForm.el,
    ]);
  }

  let loanForm = null, onBehalf = null;
  function loanFields() {
    onBehalf = h("input", { type: "checkbox" });
    const behalfRow = canBorrowBehalf ? h("label.check-row", [onBehalf, "Borrowing on behalf of someone else"]) : null;
    loanForm = buildForm([
      { name: "borrowerName", label: "Borrower name", required: true, value: canBorrowBehalf ? "" : me.name },
      { name: "employeeId", label: "Employee ID", required: true },
      { name: "department", label: "Department", required: true },
      { name: "project", label: "Project / site" },
      { name: "purpose", label: "Purpose / usage", required: true, full: true },
      { name: "borrowDate", label: "Borrow date", type: "date", value: todayISO(), required: true },
      { name: "expectedReturnDate", label: "Expected return date", type: "date", value: addDaysISO(todayISO(), 7), required: true },
    ]);
    if (!canBorrowBehalf) loanForm.field("borrowerName").disabled = true;
    if (canBorrowBehalf) {
      onBehalf.addEventListener("change", () => {
        const self = !onBehalf.checked;
        loanForm.field("borrowerName").disabled = self;
        if (self) loanForm.setValue("borrowerName", me.name);
        else if (loanForm.getValues().borrowerName === me.name) loanForm.setValue("borrowerName", "");
      });
    }
    save.textContent = "Record borrow";
    return h("div.stack", [
      h("div.muted", { style: "font-size:.82rem", text:
        "Tracked as a loan: it stays in inventory as Borrowed, shows on Borrowed Items (overdue highlighted), and is checked back in from there." }),
      behalfRow, loanForm.el,
    ]);
  }

  if (showModeChoice) modeSel.addEventListener("change", render);
  render();

  save.addEventListener("click", () => withBusy(save, async () => {
    if (!picker.validate()) return;
    const sel = picker.getSelection();
    try {
      if (mode() === "permanent") {
        if (!permanentForm.validate()) return;
        await call("issue", { ...sel, ...permanentForm.getValues() });
        toastOk("Issued — item removed from inventory");
      } else {
        if (!loanForm.validate()) return;
        await call("borrow", { ...sel, ...loanForm.getValues(), onBehalf: canBorrowBehalf && onBehalf.checked });
        toastOk("Borrow recorded — item marked Borrowed");
      }
      invalidateInventory();
      location.reload();
    } catch (e) { toastErr(e.message); }
  }));

  return card("Record an issue", h("div.stack", [
    showModeChoice ? h("div.field", { style: "max-width:420px" }, [h("label", { text: "Type" }), modeSel]) : null,
    picker.el,
    fieldsHost,
    h("div", save),
  ]));
}

async function buildRecentIssuesCard() {
  const { rows } = await call("listTransactions", { filters: { type: "ISSUE" }, limit: 50 });
  const table = dataTable({
    columns: [
      { key: "timestamp", label: "When", render: (r) => fmtDateTime(r.timestamp) },
      { key: "slipNo", label: "Slip", render: (r) => r.slipNo || "—" },
      { key: "itemCode", label: "Item", wrap: true, render: (r) => h("a", { href: `#/item/${encodeURIComponent(r.itemCode)}`, text: skuName(r.itemCode) }) },
      { key: "unitId", label: "Unit / qty", render: (r) => r.unitId ? h("span.mono", { text: r.unitId }) : `×${r.qty}` },
      { key: "party", label: "Recipient" },
      { key: "department", label: "Dept" },
      { key: "destination", label: "Destination", render: (r) => r.destination || "—" },
      { key: "purpose", label: "Purpose", wrap: true },
      { key: "notes", label: "Notes", wrap: true, render: (r) => r.notes || "—" },
      { key: "processedBy", label: "By" },
    ],
    rows,
    emptyText: "Nothing has been issued yet.",
    responsiveCards: true,
    cardTitle: (r) => `${skuName(r.itemCode)} — ${r.party}`,
  });
  const region = h("div", table.el);
  const actions = [btn("Print", "print", { sm: true, onClick: () => printSection("Recently issued", region) })];
  if (can("export")) {
    const cols = ["timestamp", "slipNo", "itemCode", "unitId", "qty", "party", "department", "destination", "purpose", "notes", "processedBy"];
    actions.push(btn("CSV", "download", { sm: true, onClick: () => exportCSV("issued-items", cols, rows) }));
    actions.push(btn("Excel", "download", { sm: true, onClick: () => exportXLSX("issued-items", cols, rows, "Issued") }));
  }
  return card(`Recently issued (permanent) — last ${rows.length}`, region, h("div.row", actions));
}

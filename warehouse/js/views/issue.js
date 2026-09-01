import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getInventory, invalidateInventory, can } from "../store.js";
import { pageHead, card, btn, withBusy } from "./_shared.js";
import { dataTable } from "../components/table.js";
import { buildForm } from "../components/form.js";
import { itemUnitPicker } from "./_picker.js";
import { toastOk, toastErr } from "../components/toast.js";
import { todayISO, fmtDate } from "../util/dates.js";
import { exportCSV, exportXLSX, printSection } from "../util/export.js";

export async function viewIssue() {
  const [{ skus, units }, issued] = await Promise.all([getInventory(true), call("listIssued")]);

  // ---------- currently issued out ----------
  const search = h("input.input--search", { type: "search", placeholder: "Search item, recipient, dept…" });
  const listCard = h("div");

  const issuedTable = dataTable({
    columns: [
      { key: "itemName", label: "Item", wrap: true, render: (r) => h("a", { href: `#/item/${encodeURIComponent(r.itemCode)}`, text: r.itemName }) },
      { key: "unitId", label: "Unit / qty", render: (r) => r.unitId ? h("span.mono", { text: r.unitId }) : `×${r.qty}` },
      { key: "recipient", label: "Recipient" },
      { key: "department", label: "Dept", render: (r) => r.department || "—" },
      { key: "destination", label: "Destination", render: (r) => r.destination || "—" },
      { key: "purpose", label: "Purpose", wrap: true },
      { key: "issueDate", label: "Issued", render: (r) => fmtDate(r.issueDate) },
      { key: "expectedReturnDate", label: "Expected back", render: (r) => r.permanent ? h("span.badge.badge--mut", { text: "permanent" }) : fmtDate(r.expectedReturnDate) },
      { key: "overdue", label: "Status", render: (r) => r.overdue ? h("span.badge.badge--err", { text: "Overdue" }) : h("span.badge.badge--info", { text: "Out" }) },
    ],
    rows: [],
    emptyText: "Nothing is currently issued out.",
    responsiveCards: true,
    cardTitle: (r) => `${r.itemName} — ${r.recipient}`,
    rowClass: (r) => (r.overdue ? "is-overdue" : ""),
  });
  listCard.appendChild(issuedTable.el);

  function applyList() {
    const q = search.value.trim().toLowerCase();
    let rows = issued.rows.slice();
    if (q) rows = rows.filter((r) => [r.itemName, r.recipient, r.department, r.destination, r.slipNo].join(" ").toLowerCase().includes(q));
    issuedTable.setRows(rows);
  }
  search.addEventListener("input", applyList);
  applyList();

  const listActions = [btn("Print", "print", { onClick: () => printSection("Issued / outgoing items", listCard) })];
  if (can("export")) {
    const cols = ["slipNo", "itemCode", "itemName", "unitId", "qty", "recipient", "employeeId", "department", "destination", "purpose", "issueDate", "expectedReturnDate", "permanent", "overdue"];
    listActions.push(btn("CSV", "download", { onClick: () => exportCSV("issued-items", cols, issued.rows) }));
    listActions.push(btn("Excel", "download", { onClick: () => exportXLSX("issued-items", cols, issued.rows, "Issued") }));
  }

  // ---------- new issue form ----------
  let formSection = null;
  if (can("issue")) {
    const picker = itemUnitPicker({ skus, units, availableOnly: true });
    const form = buildForm([
      { name: "recipient", label: "Recipient", required: true },
      { name: "department", label: "Department", required: true },
      { name: "destination", label: "Destination" },
      { name: "purpose", label: "Purpose", required: true, full: true },
      { name: "txnDate", label: "Issue date", type: "date", value: todayISO(), required: true },
      { name: "expectedReturnDate", label: "Expected return (blank = permanent)", type: "date" },
    ]);
    const save = h("button.btn.btn--primary", { text: "Record issue" });
    save.addEventListener("click", () => withBusy(save, async () => {
      if (!picker.validate() || !form.validate()) return;
      try {
        await call("issue", { ...picker.getSelection(), ...form.getValues() });
        invalidateInventory();
        toastOk("Issue recorded");
        location.reload();
      } catch (e) { toastErr(e.message); }
    }));
    formSection = card("Record an issue", h("div.stack", [
      h("div.muted", { style: "font-size:.82rem", text:
        "With an expected-return date the item is tracked as a loan and stays in this list. " +
        "Leave it blank for a permanent issue (to a customer, consumed, etc.) — a serialized unit is then marked Released and drops out of active inventory; quantity stock is simply deducted." }),
      picker.el, form.el, h("div", save),
    ]));
  }

  return h("div.stack", [
    pageHead("Issue / Outgoing", []),
    card("Currently issued out", h("div.stack", [
      h("div.toolbar", [search, h("div.toolbar__spacer"), ...listActions]),
      listCard,
    ])),
    formSection,
  ]);
}

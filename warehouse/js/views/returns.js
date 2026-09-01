import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getConfig, invalidateInventory, currentUser } from "../store.js";
import { pageHead, card, btn, withBusy } from "./_shared.js";
import { dataTable } from "../components/table.js";
import { buildForm } from "../components/form.js";
import { openModal } from "../components/modal.js";
import { toastOk, toastErr } from "../components/toast.js";
import { fmtDate, todayISO } from "../util/dates.js";

export async function viewReturns() {
  const { rows } = await call("listBorrowed");

  const table = dataTable({
    columns: [
      { key: "itemName", label: "Item", wrap: true },
      { key: "unitId", label: "Unit / qty", render: (r) => r.unitId ? h("span.mono", { text: r.unitId }) : `×${r.outstanding}` },
      { key: "borrower", label: "Borrower" },
      { key: "borrowDate", label: "Borrowed", render: (r) => fmtDate(r.borrowDate) },
      { key: "expectedReturnDate", label: "Due", render: (r) => fmtDate(r.expectedReturnDate) },
      { key: "overdue", label: "", render: (r) => r.overdue ? h("span.badge.badge--err", { text: "Overdue" }) : "" },
      { key: "_a", label: "", sortable: false, render: (r) => btn("Process return", "return", { sm: true, primary: true, onClick: () => openReturnForBorrow(r, () => location.reload()) }) },
    ],
    rows,
    emptyText: "No outstanding borrows to return.",
    responsiveCards: true,
    cardTitle: (r) => `${r.itemName} — ${r.borrower}`,
  });

  const help = h("div.card", h("div.card__body", { style: "font-size:.88rem" }, [
    h("b", { text: "What is this page?" }),
    h("p", { style: "margin:6px 0 0", text:
      "Returns is where you check borrowed items back into the warehouse. Every row below is an open borrow. " +
      "Click “Process return” to record who brought it back, who received it, the condition, and any damage or missing pieces." }),
    h("p", { style: "margin:6px 0 0", text:
      "If the item is in good condition it goes straight back to Available. If it is damaged or you tick “requires inspection”, " +
      "the unit is held as “Under inspection” until someone clears it from the item’s detail page. " +
      "For quantity items you can split the return into good vs. damaged/missing counts." }),
    h("p", { style: "margin:6px 0 0", class: "muted", text:
      "Note: this page handles items that were borrowed. Items sent out via Issue / Outgoing are tracked on the Issue page." }),
  ]));

  return h("div.stack", [
    pageHead("Returns", []),
    help,
    card("Outstanding borrows", table.el),
  ]);
}

export async function openReturnForBorrow(borrow, onDone) {
  const cfg = await getConfig();
  const me = currentUser();
  const serialized = !!borrow.unitId;

  const fields = [
    { name: "returnDate", label: "Return date", type: "date", value: todayISO(), required: true },
    { name: "returnedBy", label: "Returned by", value: borrow.borrower, required: true },
    { name: "receivedBy", label: "Received by", value: me.name, required: true },
    { name: "condition", label: "Condition", type: "select", options: cfg.conditions, value: "Good", required: true },
  ];
  if (!serialized) {
    fields.push({ name: "qtyGood", label: `Qty returned good (outstanding ${borrow.outstanding})`, type: "number", min: 0, value: borrow.outstanding, required: true });
    fields.push({ name: "qtyDamaged", label: "Qty damaged / missing", type: "number", min: 0, value: 0, required: true });
  }
  fields.push({ name: "notes", label: "Damage / missing notes", type: "textarea", full: true });

  const form = buildForm(fields);
  const inspection = h("input", { type: "checkbox" });
  const inspRow = h("label.field", { style: "flex-direction:row;align-items:center;gap:8px" }, [inspection, "Requires inspection before returning to Available"]);

  form.field("condition").addEventListener("change", () => {
    if (form.getValues().condition !== "Good") inspection.checked = true;
  });

  const body = h("div.stack", [
    h("div.muted", { text: `${borrow.itemName} · ${borrow.slipNo || ""} · borrowed by ${borrow.borrower}` }),
    form.el, inspRow,
  ]);
  const m = openModal({ title: "Process return", body });
  const save = h("button.btn.btn--primary", { text: "Confirm return" });
  m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), save]);

  save.addEventListener("click", () => withBusy(save, async () => {
    if (!form.validate()) return;
    const v = form.getValues();
    if (!serialized && (Number(v.qtyGood) + Number(v.qtyDamaged) <= 0)) {
      form.setError("qtyGood", "Enter a returned quantity"); return;
    }
    try {
      await call("returnItems", {
        borrowTxnId: borrow.txnId,
        returnDate: v.returnDate, returnedBy: v.returnedBy, receivedBy: v.receivedBy,
        condition: v.condition, notes: v.notes,
        requiresInspection: inspection.checked,
        qtyGood: v.qtyGood, qtyDamaged: v.qtyDamaged,
      });
      invalidateInventory();
      toastOk(inspection.checked ? "Return recorded — unit under inspection" : "Return recorded — item Available");
      m.close();
      onDone && onDone();
    } catch (e) { toastErr(e.message); }
  }));
}

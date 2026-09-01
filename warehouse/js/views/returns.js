// Returning borrowed items is done from the Borrowed Items page (the "Return"
// button on each row). This module just holds the shared return dialog.
import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getConfig, invalidateInventory, currentUser } from "../store.js";
import { withBusy } from "./_shared.js";
import { buildForm } from "../components/form.js";
import { openModal } from "../components/modal.js";
import { toastOk, toastErr } from "../components/toast.js";
import { todayISO } from "../util/dates.js";

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
    h("div.muted", { style: "font-size:.82rem", text:
      "Good condition returns straight to Available. Damaged / “requires inspection” holds the unit as Under inspection until it's cleared from the item page." }),
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

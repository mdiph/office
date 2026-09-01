import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getInventory, invalidateInventory, currentUser, can } from "../store.js";
import { pageHead, card, withBusy } from "./_shared.js";
import { buildForm } from "../components/form.js";
import { itemUnitPicker } from "./_picker.js";
import { toastOk, toastErr } from "../components/toast.js";
import { todayISO, addDaysISO } from "../util/dates.js";

export async function viewBorrow() {
  const { skus, units } = await getInventory(true);
  const me = currentUser();
  const picker = itemUnitPicker({ skus, units, availableOnly: true });

  const onBehalf = h("input", { type: "checkbox" });
  const canBehalf = can("borrow_behalf");
  const behalfRow = canBehalf
    ? h("label.check-row", [onBehalf, "Borrowing on behalf of someone else"])
    : null;

  const form = buildForm([
    { name: "borrowerName", label: "Borrower name", required: true, value: canBehalf ? "" : me.name },
    { name: "employeeId", label: "Employee ID", required: true },
    { name: "department", label: "Department", required: true },
    { name: "project", label: "Project / site" },
    { name: "purpose", label: "Purpose / usage", required: true, full: true },
    { name: "borrowDate", label: "Borrow date", type: "date", value: todayISO(), required: true },
    { name: "expectedReturnDate", label: "Expected return date", type: "date", value: addDaysISO(todayISO(), 7), required: true },
  ]);
  if (!canBehalf) form.field("borrowerName").disabled = true;

  if (canBehalf) {
    onBehalf.addEventListener("change", () => {
      const self = !onBehalf.checked;
      form.field("borrowerName").disabled = self;
      if (self) form.setValue("borrowerName", me.name);
      else if (form.getValues().borrowerName === me.name) form.setValue("borrowerName", "");
    });
  }

  const save = h("button.btn.btn--primary", { text: "Record borrow" });
  save.addEventListener("click", () => withBusy(save, async () => {
    if (!picker.validate() || !form.validate()) return;
    const sel = picker.getSelection();
    try {
      await call("borrow", { ...sel, ...form.getValues(), onBehalf: canBehalf && onBehalf.checked });
      invalidateInventory();
      toastOk("Borrow recorded — item marked Borrowed");
      location.reload();
    } catch (e) { toastErr(e.message); }
  }));

  return h("div.stack", [
    pageHead("Borrow", []),
    card(null, h("div.stack", [picker.el, behalfRow, form.el, h("div", save)])),
  ]);
}

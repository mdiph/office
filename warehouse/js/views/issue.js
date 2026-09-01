import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getInventory, invalidateInventory } from "../store.js";
import { pageHead, card, withBusy } from "./_shared.js";
import { buildForm } from "../components/form.js";
import { itemUnitPicker } from "./_picker.js";
import { toastOk, toastErr } from "../components/toast.js";
import { todayISO } from "../util/dates.js";

export async function viewIssue() {
  const { skus, units } = await getInventory(true);
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
    const sel = picker.getSelection();
    try {
      await call("issue", { ...sel, ...form.getValues() });
      invalidateInventory();
      toastOk("Issue recorded");
      location.reload();
    } catch (e) { toastErr(e.message); }
  }));

  return h("div.stack", [
    pageHead("Issue / Outgoing", []),
    card(null, h("div.stack", [picker.el, form.el, h("div", save)])),
  ]);
}

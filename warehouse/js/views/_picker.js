import { h } from "../util/dom.js";
import { buildForm } from "../components/form.js";

// itemUnitPicker({ skus, units, onlyAvailable }) -> { el, getSelection() }
// getSelection -> { sku, unitId, trackingType, maxQty }
export function itemUnitPicker({ skus, units, availableOnly = true }) {
  const active = skus.filter((s) => s.active);
  const form = buildForm([
    { name: "itemCode", label: "Item", type: "select", required: true,
      options: [{ value: "", label: "— select —" }, ...active.map((s) => ({ value: s.itemCode, label: `${s.itemCode} — ${s.name}` }))] },
  ]);
  const extraHost = h("div");
  form.el.appendChild(h("div.field.full", extraHost));

  let unitForm = null, qtyForm = null;

  function render() {
    const sku = active.find((s) => s.itemCode === form.getValues().itemCode);
    extraHost.innerHTML = "";
    unitForm = qtyForm = null;
    if (!sku) return;
    if (sku.trackingType === "serialized") {
      const opts = units.filter((u) => u.itemCode === sku.itemCode && (!availableOnly || u.status === "Available"))
        .map((u) => ({ value: u.unitId, label: `${u.unitId}${u.serialNumber ? " · " + u.serialNumber : ""} (${u.condition}, ${u.location})` }));
      unitForm = buildForm([{ name: "unitId", label: "Unit", type: "select", required: true,
        options: opts.length ? opts : [{ value: "", label: "No available units" }] }]);
      extraHost.appendChild(unitForm.el);
    } else {
      qtyForm = buildForm([{ name: "qty", label: `Quantity (on hand: ${sku.quantityOnHand})`, type: "number", min: 1, required: true }]);
      extraHost.appendChild(qtyForm.el);
    }
  }
  form.field("itemCode").addEventListener("change", render);

  return {
    el: form.el,
    validate() {
      if (!form.validate()) return false;
      if (unitForm) return unitForm.validate() && !!unitForm.getValues().unitId;
      if (qtyForm) return qtyForm.validate();
      return false;
    },
    getSelection() {
      const sku = active.find((s) => s.itemCode === form.getValues().itemCode);
      return {
        itemCode: sku?.itemCode,
        trackingType: sku?.trackingType,
        unitId: unitForm ? unitForm.getValues().unitId : null,
        qty: qtyForm ? qtyForm.getValues().qty : 1,
      };
    },
  };
}

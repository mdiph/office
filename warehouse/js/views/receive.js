import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getInventory, getConfig, invalidateInventory } from "../store.js";
import { pageHead, card, withBusy } from "./_shared.js";
import { buildForm } from "../components/form.js";
import { photoField } from "../components/photo.js";
import { toastOk, toastErr } from "../components/toast.js";
import { todayISO } from "../util/dates.js";

export async function viewReceive() {
  const [{ skus }, cfg] = await Promise.all([getInventory(true), getConfig()]);
  const activeSkus = skus.filter((s) => s.active);

  const modeSel = h("select", [
    h("option", { value: "new", text: "New item (create SKU)" }),
    h("option", { value: "restock", text: "Restock existing item" }),
  ]);
  const host = h("div");
  modeSel.addEventListener("change", () => render());
  render();

  function render() {
    host.innerHTML = "";
    host.appendChild(modeSel.value === "new" ? newForm() : restockForm());
  }

  function commonFields(extra) {
    return buildForm([
      { name: "purpose", label: "Reference / PO / reason", full: true, value: "Received", required: true },
      { name: "notes", label: "Notes", type: "textarea", full: true },
      ...extra,
    ]);
  }

  function newForm() {
    const meta = buildForm([
      { name: "name", label: "Product name", required: true, full: true },
      { name: "itemCode", label: "Item code (blank = auto)" },
      { name: "category", label: "Category", type: "select", required: true, options: cfg.categories },
      { name: "trackingType", label: "Tracking type", type: "select", required: true, options: [
        { value: "serialized", label: "Serialized (per-unit)" }, { value: "quantity", label: "Quantity (count)" }] },
      { name: "brand", label: "Brand", type: "datalist", options: [...new Set(skus.map((s) => s.brand).filter(Boolean))] },
      { name: "model", label: "Model" },
      { name: "specification", label: "Specification", type: "textarea", full: true },
      { name: "description", label: "Description", type: "textarea", full: true },
      { name: "txnDate", label: "Received date", type: "date", value: todayISO(), required: true },
    ]);
    const photo = photoField({ label: "Primary photo (optional)" });
    const qtyHost = h("div");
    const common = commonFields([]);
    let quantityForm, unitForms = [];

    function renderQty() {
      qtyHost.innerHTML = "";
      if (meta.getValues().trackingType === "quantity") {
        qtyHost.appendChild(quantityBlock());
      } else {
        qtyHost.appendChild(unitsBlock());
      }
    }

    function quantityBlock() {
      quantityForm = buildForm([
        { name: "qty", label: "Quantity received", type: "number", min: 1, required: true },
        { name: "location", label: "Location", type: "select", required: true, options: cfg.locations },
      ]);
      unitForms = [];
      return h("div.card", h("div.card__body", quantityForm.el));
    }
    function unitsBlock() {
      quantityForm = null;
      const count = buildForm([{ name: "count", label: "Number of units", type: "number", min: 1, value: 1, required: true }]);
      const rows = h("div.stack");
      function build() {
        const n = Math.max(1, Number(count.getValues().count) || 1);
        rows.innerHTML = ""; unitForms = [];
        for (let i = 0; i < n; i++) {
          const f = buildForm([
            { name: "serialNumber", label: `Unit ${i + 1} serial (optional)` },
            { name: "condition", label: "Condition", type: "select", options: cfg.conditions, value: "Good", required: true },
            { name: "location", label: "Location", type: "select", options: cfg.locations, required: true },
          ]);
          unitForms.push(f);
          rows.appendChild(h("div.card", h("div.card__body", f.el)));
        }
      }
      count.field("count").addEventListener("input", build);
      build();
      return h("div.stack", [count.el, rows]);
    }

    meta.field("trackingType").addEventListener("change", renderQty);
    renderQty();

    const save = h("button.btn.btn--primary", { text: "Receive & create item" });
    save.addEventListener("click", () => withBusy(save, async () => {
      if (!meta.validate() || !common.validate()) return;
      const v = { ...meta.getValues(), ...common.getValues(), mode: "new", photoFileId: photo.getFileId() };
      if (v.trackingType === "quantity") {
        if (!quantityForm.validate()) return;
        Object.assign(v, quantityForm.getValues());
      } else {
        if (unitForms.some((f) => !f.validate())) return;
        v.units = unitForms.map((f) => f.getValues());
      }
      try {
        await call("receive", v);
        invalidateInventory();
        toastOk("Item received");
        render();
      } catch (e) { toastErr(e.message); }
    }));

    return h("div.stack", [meta.el, photo.el, qtyHost, common.el, h("div", save)]);
  }

  function restockForm() {
    const pick = buildForm([
      { name: "itemCode", label: "Item", type: "select", required: true,
        options: activeSkus.map((s) => ({ value: s.itemCode, label: `${s.itemCode} — ${s.name} (${s.trackingType})` })) },
      { name: "txnDate", label: "Received date", type: "date", value: todayISO(), required: true },
    ]);
    const detailHost = h("div");
    const common = commonFields([]);
    let quantityForm = null, count = null, unitForms = [];

    function renderDetail() {
      const sku = activeSkus.find((s) => s.itemCode === pick.getValues().itemCode);
      detailHost.innerHTML = "";
      if (!sku) return;
      if (sku.trackingType === "quantity") {
        quantityForm = buildForm([
          { name: "qty", label: "Quantity to add", type: "number", min: 1, required: true },
          { name: "location", label: "Location", type: "select", required: true, options: cfg.locations },
        ]);
        unitForms = [];
        detailHost.appendChild(h("div.card", h("div.card__body", quantityForm.el)));
      } else {
        quantityForm = null;
        count = buildForm([{ name: "count", label: "Number of new units", type: "number", min: 1, value: 1, required: true }]);
        const rows = h("div.stack");
        const build = () => {
          const n = Math.max(1, Number(count.getValues().count) || 1);
          rows.innerHTML = ""; unitForms = [];
          for (let i = 0; i < n; i++) {
            const f = buildForm([
              { name: "serialNumber", label: `Unit ${i + 1} serial (optional)` },
              { name: "condition", label: "Condition", type: "select", options: cfg.conditions, value: "Good", required: true },
              { name: "location", label: "Location", type: "select", options: cfg.locations, required: true },
            ]);
            unitForms.push(f);
            rows.appendChild(h("div.card", h("div.card__body", f.el)));
          }
        };
        count.field("count").addEventListener("input", build);
        build();
        detailHost.append(count.el, rows);
      }
    }
    pick.field("itemCode").addEventListener("change", renderDetail);
    renderDetail();

    const save = h("button.btn.btn--primary", { text: "Add stock" });
    save.addEventListener("click", () => withBusy(save, async () => {
      if (!pick.validate() || !common.validate()) return;
      const v = { ...pick.getValues(), ...common.getValues(), mode: "restock" };
      if (quantityForm) { if (!quantityForm.validate()) return; Object.assign(v, quantityForm.getValues()); }
      else { if (unitForms.some((f) => !f.validate())) return; v.units = unitForms.map((f) => f.getValues()); }
      try { await call("receive", v); invalidateInventory(); toastOk("Stock added"); renderDetail(); }
      catch (e) { toastErr(e.message); }
    }));

    return h("div.stack", [pick.el, detailHost, common.el, h("div", save)]);
  }

  return h("div.stack", [
    pageHead("Receive item", []),
    card(null, h("div.stack", [
      h("div.field", { style: "max-width:340px" }, [h("label", { text: "Mode" }), modeSel]),
      host,
    ])),
  ]);
}

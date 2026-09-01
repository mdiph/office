import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getInventory, invalidateInventory, getConfig, can } from "../store.js";
import { pageHead, card, btn, statusBadge, conditionBadge, withBusy, photoUrl } from "./_shared.js";
import { dataTable } from "../components/table.js";
import { buildForm } from "../components/form.js";
import { openModal } from "../components/modal.js";
import { confirmDialog } from "../components/confirm.js";
import { photoField } from "../components/photo.js";
import { toastOk, toastErr } from "../components/toast.js";
import { fmtDate, fmtDateTime } from "../util/dates.js";

export async function viewInventory({ navigate }) {
  const [{ skus, units }, cfg] = await Promise.all([getInventory(true), getConfig()]);

  const search = h("input.input--search", { type: "search", placeholder: "Search code, name, brand, model, serial…" });
  const fCat = h("select", [h("option", { value: "", text: "All categories" }), ...cfg.categories.map((c) => h("option", { value: c, text: c }))]);
  const fStatus = h("select", [h("option", { value: "", text: "All statuses" }), ...cfg.statuses.map((c) => h("option", { value: c, text: c }))]);
  const fLoc = h("select", [h("option", { value: "", text: "All locations" }), ...cfg.locations.map((c) => h("option", { value: c, text: c }))]);
  const fType = h("select", [h("option", { value: "", text: "Any type" }), h("option", { value: "serialized", text: "Serialized" }), h("option", { value: "quantity", text: "Quantity" })]);

  const unitsBy = {};
  units.forEach((u) => (unitsBy[u.itemCode] ||= []).push(u));

  const lowThreshold = cfg.lowStockThreshold ?? 0;

  function rowStatus(s) {
    if (s.trackingType === "quantity") {
      const q = Number(s.quantityOnHand || 0);
      const text = `${q} in stock`;
      if (q <= 0) return h("span.badge.badge--err", { text: "Out of stock" });
      if (q <= lowThreshold) return h("span.badge.badge--warn", { text: `${text} (low)` });
      return text;
    }
    const us = unitsBy[s.itemCode] || [];
    const avail = us.filter((u) => u.status === "Available").length;
    return `${avail} of ${us.length} available`;
  }

  const table = dataTable({
    columns: [
      { key: "itemCode", label: "Code", render: (s) => h("a.mono", { href: `#/item/${encodeURIComponent(s.itemCode)}`, text: s.itemCode }) },
      { key: "name", label: "Name", wrap: true },
      { key: "category", label: "Category" },
      { key: "brand", label: "Brand" },
      { key: "model", label: "Model" },
      { key: "trackingType", label: "Type", render: (s) => h("span.badge.badge--mut", { text: s.trackingType }) },
      { key: "stock", label: "Stock", sortValue: (s) => s.trackingType === "quantity" ? s.quantityOnHand : (unitsBy[s.itemCode] || []).length, render: rowStatus },
      { key: "active", label: "", render: (s) => s.active ? "" : h("span.badge.badge--err", { text: "archived" }), sortable: false },
    ],
    rows: [],
    emptyText: "No items match.",
    responsiveCards: true,
    cardTitle: (s) => `${s.itemCode} — ${s.name}`,
    pageSize: 50,
  });

  function apply() {
    const q = search.value.trim().toLowerCase();
    let list = skus.slice();
    if (fCat.value) list = list.filter((s) => s.category === fCat.value);
    if (fType.value) list = list.filter((s) => s.trackingType === fType.value);
    if (fLoc.value) list = list.filter((s) => (unitsBy[s.itemCode] || []).some((u) => u.location === fLoc.value));
    if (fStatus.value) list = list.filter((s) => (unitsBy[s.itemCode] || []).some((u) => u.status === fStatus.value));
    if (q) {
      list = list.filter((s) => {
        const us = unitsBy[s.itemCode] || [];
        return [s.itemCode, s.name, s.brand, s.model, s.category].join(" ").toLowerCase().includes(q)
          || us.some((u) => (u.serialNumber || "").toLowerCase().includes(q));
      });
    }
    table.setRows(list);
  }
  [search, fCat, fStatus, fLoc, fType].forEach((el) => el.addEventListener("input", apply));
  apply();

  const actions = [];
  if (can("receive")) {
    actions.push(btn("Receive stock", "arrow-in", { primary: true, onClick: () => navigate("#/receive") }));
  }

  return h("div.stack", [
    pageHead("Inventory", actions),
    can("inventory_write")
      ? h("div.muted", { style: "margin:-6px 0 4px;font-size:.85rem",
          text: "New items and additional stock are added from Receive. Here you can edit item details and individual units." })
      : null,
    card(null, h("div.stack", [
      h("div.toolbar", [search, fType, fCat, fStatus, fLoc]),
      table.el,
    ])),
  ]);
}

// ---------- SKU create / edit ----------
export function openSkuForm(cfg, existing, onDone) {
  const isEdit = !!existing;
  const form = buildForm([
    { name: "name", label: "Product name", required: true, full: true, value: existing?.name },
    { name: "itemCode", label: "Item code (blank = auto)", value: existing?.itemCode, help: isEdit ? "Code cannot be changed." : "" },
    { name: "category", label: "Category", type: "select", required: true, options: cfg.categories, value: existing?.category },
    { name: "trackingType", label: "Tracking type", type: "select", required: true, options: [{ value: "serialized", label: "Serialized (per-unit)" }, { value: "quantity", label: "Quantity (count)" }], value: existing?.trackingType || "serialized" },
    { name: "brand", label: "Brand", type: "datalist", options: cfg.brands || [], value: existing?.brand },
    { name: "model", label: "Model", type: "datalist", options: cfg.models || [], value: existing?.model },
    { name: "specification", label: "Specification", type: "textarea", full: true, value: existing?.specification },
    { name: "description", label: "Description", type: "textarea", full: true, value: existing?.description },
  ]);
  if (isEdit) { form.field("itemCode").disabled = true; form.field("trackingType").disabled = existing.hasTxns; }

  const photo = photoField({ value: existing?.photoFileId, label: "Primary photo" });
  const body = h("div.stack", [form.el, photo.el]);
  const m = openModal({ title: isEdit ? `Edit ${existing.itemCode}` : "Add item", body, wide: true });
  const save = h("button.btn.btn--primary", { text: isEdit ? "Save changes" : "Create item" });
  m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), save]);

  save.addEventListener("click", () => withBusy(save, async () => {
    if (!form.validate()) return;
    const v = form.getValues();
    v.photoFileId = photo.getFileId();
    try {
      if (isEdit) {
        await call("updateSku", { itemCode: existing.itemCode, patch: {
          name: v.name, category: v.category, brand: v.brand, model: v.model,
          specification: v.specification, description: v.description, photoFileId: v.photoFileId,
        } });
        toastOk("Item updated");
      } else {
        await call("createSku", v);
        toastOk("Item created");
      }
      m.close();
      onDone && onDone();
    } catch (e) { toastErr(e.message); }
  }));
}

// ---------- Item detail ----------
export async function viewItemDetail({ args, navigate }) {
  const code = decodeURIComponent(args[0] || "");
  const [{ sku, units, history }, cfg] = await Promise.all([call("getItem", { itemCode: code }), getConfig()]);

  const photo = photoUrl(sku.photoFileId);
  const head = h("div.detail-head", [
    photo ? h("img.detail-photo", { src: photo, alt: sku.name }) : h("div.detail-photo"),
    h("div", { style: "flex:1" }, [
      h("h1", { text: sku.name, style: "margin-bottom:4px" }),
      h("div.muted", { text: `${sku.itemCode} · ${sku.category} · ${sku.trackingType}` }),
      h("dl.kvlist", { style: "margin-top:10px" }, [
        kv("Brand", sku.brand), kv("Model", sku.model),
        kv("Specification", sku.specification), kv("Description", sku.description),
        sku.trackingType === "quantity" ? kv("Quantity on hand", String(sku.quantityOnHand)) : null,
        kv("Created", `${fmtDateTime(sku.createdAt)} by ${sku.createdBy || "—"}`),
      ]),
    ]),
  ]);

  const detailActions = [];
  if (can("inventory_write")) {
    detailActions.push(btn("Edit", "edit", { sm: true, onClick: () => openSkuForm(cfg, { ...sku, hasTxns: history.length > 0 }, () => { invalidateInventory(); location.reload(); }) }));
    if (can("receive")) {
      detailActions.push(btn("Receive more", "arrow-in", { sm: true, onClick: () => (location.hash = "#/receive") }));
    }
    if (sku.active) {
      detailActions.push(btn("Archive", "trash", { sm: true, danger: true, onClick: async () => {
        if (!(await confirmDialog({ title: "Archive item?", message: "This soft-deletes the SKU. Blocked if stock or open transactions exist.", confirmLabel: "Archive", danger: true }))) return;
        try { await call("deleteSku", { itemCode: sku.itemCode }); invalidateInventory(); toastOk("Archived"); location.reload(); }
        catch (e) { toastErr(e.message); }
      } }));
    }
  }

  let unitsCard = null;
  if (sku.trackingType === "serialized") {
    const ut = dataTable({
      columns: [
        { key: "unitId", label: "Unit", render: (u) => h("span.mono", { text: u.unitId }) },
        { key: "serialNumber", label: "Serial", render: (u) => u.serialNumber || "—" },
        { key: "condition", label: "Condition", render: (u) => conditionBadge(u.condition) },
        { key: "status", label: "Status", render: (u) => statusBadge(u.status) },
        { key: "location", label: "Location" },
        { key: "currentHolder", label: "Holder", render: (u) => u.currentHolder || "—" },
        { key: "_a", label: "", sortable: false, render: (u) => {
          const wrap = h("div.row");
          if (can("inventory_write")) wrap.appendChild(btn("Edit", null, { sm: true, onClick: () => openEditUnit(u, cfg, () => location.reload()) }));
          if (u.status === "Under inspection" && can("return")) wrap.appendChild(btn("Clear inspection", null, { sm: true, onClick: () => openClearInspection(u, () => location.reload()) }));
          return wrap;
        } },
      ],
      rows: units,
      emptyText: "No units — all have been issued out, retired, or lost. See History below.",
    });
    unitsCard = card(`Units (${units.length})`, ut.el);
  }

  const timeline = h("div.timeline", history.slice().reverse().map((e) => h("div.ev", [
    h("div", [h("span.badge", { text: e.type }), " ", e.itemCode, e.unitId ? h("span.mono", { text: " " + e.unitId }) : "",
      e.qty ? ` ×${e.qty}` : "", e.party ? ` — ${e.party}` : ""]),
    h("div.when", { text: `${fmtDateTime(e.timestamp)} · ${e.processedBy || ""}${e.purpose ? " · " + e.purpose : ""}` }),
  ])));

  return h("div.stack", [
    h("div.toolbar", [btn("Back to inventory", null, { onClick: () => navigate("#/inventory") }), h("div.toolbar__spacer"), ...detailActions]),
    card(null, head),
    unitsCard,
    card("History", history.length ? timeline : h("div.empty", { text: "No transactions yet." })),
  ]);

  function kv(k, v) { return v ? h("div", [h("dt", { text: k }), h("dd", { text: v })]) : null; }
}

export function openEditUnit(unit, cfg, onDone) {
  const form = buildForm([
    { name: "serialNumber", label: "Serial number", value: unit.serialNumber },
    { name: "condition", label: "Condition", type: "select", options: cfg.conditions, value: unit.condition, required: true },
    { name: "location", label: "Location", type: "select", options: cfg.locations, value: unit.location, required: true },
  ]);
  const m = openModal({ title: `Edit ${unit.unitId}`, body: form.el });
  const save = h("button.btn.btn--primary", { text: "Save" });
  m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), save]);
  save.addEventListener("click", () => withBusy(save, async () => {
    if (!form.validate()) return;
    try { await call("updateUnit", { unitId: unit.unitId, patch: form.getValues() }); toastOk("Unit updated"); m.close(); onDone(); }
    catch (e) { toastErr(e.message); }
  }));
}

export function openClearInspection(unit, onDone) {
  const form = buildForm([
    { name: "outcome", label: "Outcome", type: "select", required: true, options: [
      { value: "Available", label: "Back to Available" },
      { value: "Maintenance", label: "Send to Maintenance" },
      { value: "Retired", label: "Retire unit" },
    ] },
    { name: "notes", label: "Notes", type: "textarea", full: true },
  ]);
  const m = openModal({ title: `Clear inspection — ${unit.unitId}`, body: form.el });
  const save = h("button.btn.btn--primary", { text: "Apply" });
  m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), save]);
  save.addEventListener("click", () => withBusy(save, async () => {
    try { await call("clearInspection", { unitId: unit.unitId, outcome: form.getValues().outcome, notes: form.getValues().notes }); toastOk("Inspection cleared"); m.close(); onDone(); }
    catch (e) { toastErr(e.message); }
  }));
}

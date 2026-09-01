import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getConfig, can, currentUser, invalidateInventory } from "../store.js";
import { pageHead, card, btn, withBusy } from "./_shared.js";
import { buildForm } from "../components/form.js";
import { confirmDialog } from "../components/confirm.js";
import { openChangePassword } from "../auth.js";
import { toastOk, toastErr } from "../components/toast.js";

export async function viewSettings() {
  const cfg = await getConfig(true);
  const me = currentUser();
  const admin = can("config_write");

  const account = card("My account", h("div.stack", [
    h("dl.kvlist", [
      h("div", [h("dt", { text: "Name" }), h("dd", { text: me.name })]),
      h("div", [h("dt", { text: "Email" }), h("dd", h("span.mono", { text: me.email }))]),
      h("div", [h("dt", { text: "Role" }), h("dd", { text: me.role })]),
    ]),
    h("div", btn("Change password", "shield", { onClick: openChangePassword })),
  ]));

  if (!admin) {
    return h("div.stack", [pageHead("Settings", []), account,
      card("Reference", refBlock(cfg))]);
  }

  const thresholds = buildForm([
    { name: "lowStockThreshold", label: "Low-stock threshold", type: "number", min: 0, value: cfg.lowStockThreshold, required: true },
    { name: "overdueGraceDays", label: "Overdue grace days", type: "number", min: 0, value: cfg.overdueGraceDays, required: true },
  ]);
  const saveT = h("button.btn.btn--primary", { text: "Save thresholds" });
  saveT.addEventListener("click", () => withBusy(saveT, async () => {
    try { await call("updateConfig", thresholds.getValues()); toastOk("Saved"); }
    catch (e) { toastErr(e.message); }
  }));

  const categories = editableList({
    items: cfg.categories,
    addLabel: "New category name",
    add: (v) => call("addCategory", { name: v }).then((r) => r.categories),
    rename: (oldV, newV) => call("renameCategory", { old: oldV, new: newV }).then((r) => r.categories),
    remove: (v) => call("deleteCategory", { name: v }).then((r) => r.categories),
  });

  const locations = editableList({
    items: cfg.locations,
    addLabel: "New location code",
    transform: (v) => v.toUpperCase(),
    add: (v) => call("addLocation", { code: v }).then((r) => r.locations),
    rename: (oldV, newV) => call("renameLocation", { old: oldV, new: newV }).then((r) => r.locations),
    remove: (v) => call("deleteLocation", { code: v }).then((r) => r.locations),
  });

  return h("div.stack", [
    pageHead("Settings", []),
    account,
    card("Thresholds", h("div.stack", [thresholds.el, h("div", saveT)])),
    card("Categories", categories.el),
    card("Locations", locations.el),
    card("Fixed vocabularies (defined in code)", refBlock(cfg)),
  ]);
}

// Reusable add / rename / delete list for a controlled vocabulary.
function editableList({ items, addLabel, add, rename, remove, transform }) {
  const listHost = h("div.stack", { style: "gap:6px" });
  const input = h("input", { placeholder: addLabel, style: "max-width:280px" });
  const addBtn = btn("Add", "plus", { sm: true, primary: true });

  let current = (items || []).slice();

  function paint() {
    listHost.innerHTML = "";
    if (!current.length) { listHost.appendChild(h("div.muted", { text: "None yet." })); return; }
    current.slice().sort().forEach((name) => {
      const row = h("div.row", { style: "align-items:center;gap:8px" }, [
        h("span.badge", { text: name, style: "font-size:.85rem" }),
        btn("Rename", "edit", { sm: true, onClick: () => doRename(name) }),
        btn("Delete", "trash", { sm: true, danger: true, onClick: () => doRemove(name) }),
      ]);
      listHost.appendChild(row);
    });
  }

  async function refreshFrom(promise, okMsg) {
    try {
      current = await promise;
      paint();
      toastOk(okMsg);
      invalidateCaches();
    } catch (e) { toastErr(e.message); }
  }

  addBtn.addEventListener("click", () => withBusy(addBtn, async () => {
    let v = input.value.trim();
    if (!v) return;
    if (transform) v = transform(v);
    await refreshFrom(add(v), "Added");
    input.value = "";
  }));

  async function doRename(oldV) {
    let next = window.prompt(`Rename "${oldV}" to:`, oldV);
    if (next === null) return;
    next = next.trim();
    if (transform) next = transform(next);
    if (!next || next === oldV) return;
    await refreshFrom(rename(oldV, next), "Renamed — existing records updated");
  }

  async function doRemove(v) {
    if (!(await confirmDialog({ title: `Delete "${v}"?`, message: "Blocked if any record still uses it.", confirmLabel: "Delete", danger: true }))) return;
    await refreshFrom(remove(v), "Deleted");
  }

  paint();
  return { el: h("div.stack", [h("div.toolbar", [input, addBtn]), listHost]) };
}

function invalidateCaches() {
  // categories/locations changed — force config + inventory re-fetch on next view
  getConfig(true).catch(() => {});
  invalidateInventory();
}

function refBlock(cfg) {
  return h("div.stack", [
    h("div", [h("b", { text: "Statuses: " }), ...cfg.statuses.map((s) => h("span.badge.badge--mut", { text: s, style: "margin:2px" }))]),
    h("div", [h("b", { text: "Conditions: " }), ...cfg.conditions.map((s) => h("span.badge.badge--mut", { text: s, style: "margin:2px" }))]),
    h("div", [h("b", { text: "Roles: " }), ...cfg.roles.map((s) => h("span.badge.badge--info", { text: s, style: "margin:2px" }))]),
  ]);
}

import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getConfig, can, currentUser } from "../store.js";
import { pageHead, card, btn, withBusy } from "./_shared.js";
import { buildForm } from "../components/form.js";
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

  const catInput = h("input", { placeholder: "New category name" });
  const addCat = btn("Add", "plus", { sm: true, onClick: () => withBusy(addCat, async () => {
    if (!catInput.value.trim()) return;
    try { const r = await call("addCategory", { name: catInput.value.trim() }); renderList(catList, r.categories); catInput.value = ""; toastOk("Added"); }
    catch (e) { toastErr(e.message); }
  }) });
  const catList = h("div.row");
  renderList(catList, cfg.categories);

  const locInput = h("input", { placeholder: "New location code" });
  const addLoc = btn("Add", "plus", { sm: true, onClick: () => withBusy(addLoc, async () => {
    if (!locInput.value.trim()) return;
    try { const r = await call("addLocation", { code: locInput.value.trim() }); renderList(locList, r.locations); locInput.value = ""; toastOk("Added"); }
    catch (e) { toastErr(e.message); }
  }) });
  const locList = h("div.row");
  renderList(locList, cfg.locations);

  return h("div.stack", [
    pageHead("Settings", []),
    account,
    card("Thresholds", h("div.stack", [thresholds.el, h("div", saveT)])),
    card("Categories", h("div.stack", [h("div.toolbar", [catInput, addCat]), catList])),
    card("Locations", h("div.stack", [h("div.toolbar", [locInput, addLoc]), locList])),
    card("Fixed vocabularies (defined in code)", refBlock(cfg)),
  ]);
}

function renderList(host, items) {
  host.innerHTML = "";
  (items || []).forEach((i) => host.appendChild(h("span.badge", { text: i })));
}

function refBlock(cfg) {
  return h("div.stack", [
    h("div", [h("b", { text: "Statuses: " }), ...cfg.statuses.map((s) => h("span.badge.badge--mut", { text: s, style: "margin:2px" }))]),
    h("div", [h("b", { text: "Conditions: " }), ...cfg.conditions.map((s) => h("span.badge.badge--mut", { text: s, style: "margin:2px" }))]),
    h("div", [h("b", { text: "Roles: " }), ...cfg.roles.map((s) => h("span.badge.badge--info", { text: s, style: "margin:2px" }))]),
  ]);
}

import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getInventory } from "../store.js";
import { pageHead, card, btn } from "./_shared.js";
import { buildForm } from "../components/form.js";
import { dataTable } from "../components/table.js";
import { fmtDateTime, fmtDate } from "../util/dates.js";
import { exportCSV, printSection } from "../util/export.js";

export async function viewHistory() {
  const { skus, units } = await getInventory(true);

  const pick = buildForm([
    { name: "itemCode", label: "Item", type: "select", required: true,
      options: [{ value: "", label: "— select an item —" }, ...skus.map((s) => ({ value: s.itemCode, label: `${s.itemCode} — ${s.name}` }))] },
    { name: "unitId", label: "Unit (optional)", type: "select", options: [{ value: "", label: "All units" }] },
  ]);

  const out = h("div");

  function refreshUnitOptions() {
    const code = pick.getValues().itemCode;
    const opts = [{ value: "", label: "All units" },
      ...units.filter((u) => u.itemCode === code).map((u) => ({ value: u.unitId, label: u.unitId + (u.serialNumber ? " · " + u.serialNumber : "") }))];
    pick.setOptions("unitId", opts);
  }

  async function load() {
    const { itemCode, unitId } = pick.getValues();
    if (!itemCode) { out.innerHTML = ""; return; }
    out.innerHTML = "";
    const { rows } = await call("itemHistory", { itemCode, unitId: unitId || undefined });
    const timeline = h("div.timeline", rows.slice().reverse().map((e) => h("div.ev", [
      h("div", [h("span.badge", { text: e.type }), e.unitId ? h("span.mono", { text: " " + e.unitId }) : "",
        e.qty ? ` ×${e.qty}` : "", e.party ? ` — ${e.party}` : ""]),
      h("div.when", { text: `${fmtDateTime(e.timestamp)} · ${e.processedBy || ""}${e.purpose ? " · " + e.purpose : ""}${e.notes ? " · " + e.notes : ""}` }),
    ])));
    const cols = ["timestamp", "txnDate", "type", "unitId", "qty", "qtyDamaged", "party", "department", "purpose", "condition", "expectedReturnDate", "processedBy", "notes"];
    const tbl = dataTable({
      columns: cols.map((c) => ({ key: c, label: c, render: c === "timestamp" ? (r) => fmtDateTime(r[c]) : undefined })),
      rows, emptyText: "No history.",
    });
    const region = h("div.stack", [
      card("Timeline", rows.length ? timeline : h("div.empty", { text: "No transactions." })),
      card("All events", tbl.el, h("div.row", [
        btn("Print", "print", { sm: true, onClick: () => printSection(`History — ${itemCode}`, region) }),
        btn("CSV", "download", { sm: true, onClick: () => exportCSV(`history-${itemCode}`, cols, rows) }),
      ])),
    ]);
    out.appendChild(region);
  }

  pick.field("itemCode").addEventListener("change", () => { refreshUnitOptions(); load(); });
  pick.field("unitId").addEventListener("change", load);

  return h("div.stack", [
    pageHead("Item History", []),
    card(null, pick.el),
    out,
  ]);
}

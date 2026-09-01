import { h } from "../util/dom.js";
import { call } from "../api.js";
import { fmtDateTime } from "../util/dates.js";
import { pageHead, card, btn, statusBadge } from "./_shared.js";
import { barChart, doughnutChart, stackedBar } from "../components/chart.js";
import { skuName, getInventory } from "../store.js";

export async function viewDashboard() {
  const [d] = await Promise.all([call("getDashboard"), getInventory().catch(() => null)]);
  const t = d.tiles;

  const tiles = [
    ["SKUs", t.skus],
    ["Total stock", t.totalStock],
    ["Available", t.available],
    ["Borrowed", t.borrowed],
    ["Overdue", t.overdue, t.overdue > 0 ? "err" : ""],
    ["Low stock", t.lowStock, t.lowStock > 0 ? "warn" : ""],
    ["Under inspection", t.underInspection, t.underInspection > 0 ? "warn" : ""],
  ].map(([label, value, kind]) =>
    h(`div.tile${kind ? ".tile--" + kind : ""}`, [
      h("div.tile__label", { text: label }),
      h("div.tile__value", { text: String(value ?? 0) }),
    ]));

  const recent = h("div.table-wrap", h("table.tbl", [
    h("thead", h("tr", ["When", "Type", "Item", "Qty", "Party", "By"].map((x) => h("th", { text: x })))),
    h("tbody", (d.recent || []).map((r) => h("tr", [
      h("td", { text: fmtDateTime(r.timestamp) }),
      h("td", h("span.badge", { text: r.type })),
      h("td", { text: skuName(r.itemCode) }),
      h("td.num", { text: String(r.qty ?? "") }),
      h("td", { text: r.party || "—" }),
      h("td", { text: r.processedBy || "—" }),
    ]))),
  ]));

  const byCat = d.charts.byCategory || [];
  const status = d.charts.statusBreakdown || [];
  const act = d.charts.activity30d || [];
  const actTypes = ["RECEIVE", "ISSUE", "BORROW", "RETURN"];

  const grid = h("div.grid2", [
    card("Inventory by category",
      barChart({ labels: byCat.map((x) => x.label), values: byCat.map((x) => x.value), horizontal: true })),
    card("Stock status",
      doughnutChart({ labels: status.map((x) => x.label), values: status.map((x) => x.value) })),
  ]);
  const activityCard = card("Activity — last 30 days",
    stackedBar({
      labels: act.map((x) => x.date.slice(5)),
      series: actTypes.map((ty) => ({ label: ty, data: act.map((x) => x[ty] || 0) })),
    }));

  const lists = h("div.grid2", [
    card("Overdue items", overdueTable(d.overdueItems || [])),
    card("Low-stock items", lowStockTable(d.lowStockItems || [])),
  ]);

  return h("div.stack", [
    pageHead("Dashboard", [btn("Refresh", "refresh", { onClick: () => location.reload() })]),
    h("div.tiles", tiles),
    grid,
    activityCard,
    lists,
    card("Recent transactions", recent),
  ]);
}

function overdueTable(rows) {
  if (!rows.length) return h("div.empty", { text: "Nothing overdue." });
  return h("div.table-wrap", h("table.tbl", [
    h("thead", h("tr", ["Item", "Borrower", "Due", "Qty"].map((x) => h("th", { text: x })))),
    h("tbody", rows.map((r) => h("tr.is-overdue", [
      h("td", { text: skuName(r.itemCode) }),
      h("td", { text: r.borrower }),
      h("td", { text: r.expectedReturnDate }),
      h("td.num", { text: String(r.outstanding) }),
    ]))),
  ]));
}

function lowStockTable(rows) {
  if (!rows.length) return h("div.empty", { text: "All stock above threshold." });
  return h("div.table-wrap", h("table.tbl", [
    h("thead", h("tr", ["Item", "Code", "On hand"].map((x) => h("th", { text: x })))),
    h("tbody", rows.map((r) => h("tr", [
      h("td", { text: r.name }),
      h("td", h("span.mono", { text: r.itemCode })),
      h("td.num", { text: String(r.quantityOnHand) }),
    ]))),
  ]));
}

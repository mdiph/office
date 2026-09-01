import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getInventory, skuName } from "../store.js";
import { pageHead, card, btn } from "./_shared.js";
import { buildForm } from "../components/form.js";
import { dataTable } from "../components/table.js";
import { fmtDateTime, fmtDate } from "../util/dates.js";
import { exportCSV, printSection } from "../util/export.js";

const TXN_TYPES = ["", "RECEIVE", "ISSUE", "BORROW", "RETURN", "ADJUST"];

export async function viewHistory() {
  const { skus, units } = await getInventory(true);

  const filters = buildForm([
    { name: "itemCode", label: "Item", type: "select",
      options: [{ value: "", label: "All items" }, ...skus.map((s) => ({ value: s.itemCode, label: `${s.itemCode} — ${s.name}` }))] },
    { name: "unitId", label: "Unit", type: "select", options: [{ value: "", label: "All units" }] },
    { name: "type", label: "Type", type: "select", options: TXN_TYPES.map((t) => ({ value: t, label: t || "All types" })) },
  ]);

  const timelineCard = h("div");
  const tableHost = h("div");
  const pager = h("div.pager");
  const region = h("div.stack", [timelineCard, card("Events", h("div", [tableHost, pager]))]);

  const cols = ["timestamp", "txnDate", "type", "itemCode", "unitId", "qty", "qtyDamaged", "party",
    "department", "purpose", "condition", "expectedReturnDate", "processedBy", "notes"];

  let rows = [];
  let cursor = 0;

  const table = dataTable({
    columns: [
      { key: "timestamp", label: "When", render: (r) => fmtDateTime(r.timestamp), sortValue: (r) => r.timestamp },
      { key: "type", label: "Type", render: (r) => h("span.badge", { text: r.type }) },
      { key: "itemCode", label: "Item", wrap: true, render: (r) => h("a", { href: `#/item/${encodeURIComponent(r.itemCode)}`, text: skuName(r.itemCode) }) },
      { key: "unitId", label: "Unit", render: (r) => r.unitId ? h("span.mono", { text: r.unitId }) : "—" },
      { key: "qty", label: "Qty", num: true, render: (r) => String(r.qty ?? "") },
      { key: "party", label: "Party", render: (r) => r.party || "—" },
      { key: "purpose", label: "Purpose", wrap: true },
      { key: "expectedReturnDate", label: "Due", render: (r) => r.expectedReturnDate ? fmtDate(r.expectedReturnDate) : "—" },
      { key: "processedBy", label: "By" },
    ],
    rows: [],
    emptyText: "No transactions match.",
    pageSize: 100,
    responsiveCards: true,
    tallScroll: true,
    cardTitle: (r) => `${r.type} · ${skuName(r.itemCode)}`,
  });
  tableHost.appendChild(table.el);

  function renderTimeline(list, scoped) {
    timelineCard.innerHTML = "";
    if (!scoped) return; // only show the timeline when narrowed to a single item/unit
    const tl = h("div.timeline", list.slice().reverse().map((e) => h("div.ev", [
      h("div", [h("span.badge", { text: e.type }), e.unitId ? h("span.mono", { text: " " + e.unitId }) : "",
        e.qty ? ` ×${e.qty}` : "", e.party ? ` — ${e.party}` : ""]),
      h("div.when", { text: `${fmtDateTime(e.timestamp)} · ${e.processedBy || ""}${e.purpose ? " · " + e.purpose : ""}${e.notes ? " · " + e.notes : ""}` }),
    ])));
    timelineCard.appendChild(card("Timeline", list.length ? tl : h("div.empty", { text: "No events." })));
  }

  async function load(reset) {
    const f = filters.getValues();
    const scoped = !!(f.itemCode || f.unitId);
    if (reset) { rows = []; cursor = 0; }

    if (scoped) {
      const res = await call("itemHistory", { itemCode: f.itemCode || undefined, unitId: f.unitId || undefined });
      rows = res.rows.filter((r) => !f.type || r.type === f.type)
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      pager.innerHTML = "";
      renderTimeline(rows, true);
    } else {
      const res = await call("listTransactions", { filters: { type: f.type || undefined }, cursor, limit: 100 });
      rows = reset ? res.rows : rows.concat(res.rows);
      cursor = res.nextCursor || 0;
      pager.innerHTML = "";
      if (res.nextCursor) pager.appendChild(btn("Load more", null, { onClick: () => load(false) }));
      renderTimeline([], false);
    }
    table.setRows(rows);
  }

  function refreshUnitOptions() {
    const code = filters.getValues().itemCode;
    const opts = [{ value: "", label: "All units" },
      ...units.filter((u) => u.itemCode === code).map((u) => ({ value: u.unitId, label: u.unitId + (u.serialNumber ? " · " + u.serialNumber : "") }))];
    filters.setOptions("unitId", opts);
  }

  filters.field("itemCode").addEventListener("change", () => { refreshUnitOptions(); load(true); });
  filters.field("unitId").addEventListener("change", () => load(true));
  filters.field("type").addEventListener("change", () => load(true));

  await load(true);

  const actions = [
    btn("Print", "print", { onClick: () => printSection("Item history", region) }),
    btn("CSV", "download", { onClick: () => exportCSV("transaction-history", cols, rows) }),
  ];

  return h("div.stack", [
    pageHead("Item History", actions),
    card(null, filters.el),
    region,
  ]);
}

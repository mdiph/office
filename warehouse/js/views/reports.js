import { h } from "../util/dom.js";
import { call } from "../api.js";
import { can } from "../store.js";
import { pageHead, card, btn, withBusy } from "./_shared.js";
import { dataTable } from "../components/table.js";
import { buildForm } from "../components/form.js";
import { exportCSV, exportXLSX, printSection } from "../util/export.js";
import { toastErr } from "../components/toast.js";
import { todayISO, addDaysISO } from "../util/dates.js";

const REPORTS = [
  { key: "inventory", label: "Inventory", dates: false },
  { key: "incoming", label: "Incoming items", dates: true },
  { key: "outgoing", label: "Outgoing items", dates: true },
  { key: "borrowed", label: "Borrowed items", dates: false },
  { key: "overdue", label: "Overdue items", dates: false },
  { key: "transactions", label: "Transaction history", dates: true },
  { key: "audit", label: "Audit logs", dates: true, cap: "audit" },
];

export async function viewReports() {
  const dateForm = buildForm([
    { name: "dateFrom", label: "From", type: "date", value: addDaysISO(todayISO(), -30) },
    { name: "dateTo", label: "To", type: "date", value: todayISO() },
  ]);

  const resultHost = h("div");
  const buttons = REPORTS.filter((r) => !r.cap || can(r.cap)).map((r) => {
    const b = btn(r.label, "chart", { onClick: () => run(r, b) });
    return b;
  });

  async function run(r, b) {
    await withBusy(b, async () => {
      const filters = r.dates ? dateForm.getValues() : {};
      let data;
      try {
        data = await call("exportData", { report: r.key, filters });
      } catch (e) { toastErr(e.message); return; }
      const { columns, rows } = data;
      const tbl = dataTable({
        columns: columns.map((c) => ({ key: c, label: c })),
        rows, emptyText: "No rows for this report.",
      });
      const region = h("div", tbl.el);
      resultHost.innerHTML = "";
      resultHost.appendChild(card(`${r.label} — ${rows.length} rows`, region, h("div.row", [
        btn("CSV", "download", { sm: true, onClick: () => exportCSV(r.key, columns, rows) }),
        btn("Excel", "download", { sm: true, onClick: () => exportXLSX(r.key, columns, rows, r.label) }),
        btn("Print", "print", { sm: true, onClick: () => printSection(r.label, region) }),
      ])));
    });
  }

  return h("div.stack", [
    pageHead("Reports & Export", []),
    card("Date range (for dated reports & audit)", dateForm.el),
    card("Reports", h("div.row", buttons)),
    resultHost,
  ]);
}

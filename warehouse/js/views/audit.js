import { h } from "../util/dom.js";
import { call } from "../api.js";
import { can } from "../store.js";
import { pageHead, card, btn, withBusy } from "./_shared.js";
import { dataTable } from "../components/table.js";
import { buildForm } from "../components/form.js";
import { fmtDateTime, todayISO, addDaysISO } from "../util/dates.js";
import { exportCSV, exportXLSX } from "../util/export.js";
import { toastErr } from "../components/toast.js";

const ACTIONS = ["", "LOGIN", "LOGOUT", "RECEIVE", "ISSUE", "BORROW", "RETURN", "ITEM_ADD", "ITEM_EDIT", "ITEM_DELETE", "USER_CHANGE", "CONFIG", "EXPORT"];

export async function viewAudit() {
  const filters = buildForm([
    { name: "dateFrom", label: "From", type: "date", value: addDaysISO(todayISO(), -7), required: true },
    { name: "dateTo", label: "To", type: "date", value: todayISO(), required: true },
    { name: "action", label: "Action", type: "select", options: ACTIONS.map((a) => ({ value: a, label: a || "All" })) },
    { name: "user", label: "User email contains" },
  ]);

  let rows = [];
  let cursor = 0;
  const tableHost = h("div");
  const pager = h("div.pager");

  const table = dataTable({
    columns: [
      { key: "timestamp", label: "When", render: (r) => fmtDateTime(r.timestamp) },
      { key: "userEmail", label: "User" },
      { key: "role", label: "Role" },
      { key: "action", label: "Action", render: (r) => h("span.badge", { text: r.action }) },
      { key: "targetType", label: "Target" },
      { key: "targetId", label: "ID", render: (r) => h("span.mono", { text: r.targetId || "" }) },
      { key: "summary", label: "Summary", wrap: true },
      { key: "result", label: "Result", render: (r) => h(`span.badge.badge--${r.result === "denied" ? "err" : r.result === "error" ? "warn" : "ok"}`, { text: r.result }) },
    ],
    rows: [],
    emptyText: "No audit entries in range.",
    pageSize: 100,
  });
  tableHost.appendChild(table.el);

  async function load(reset) {
    const btnRun = runBtn;
    await withBusy(btnRun, async () => {
      if (reset) { rows = []; cursor = 0; }
      const f = filters.getValues();
      try {
        const res = await call("listAudit", { filters: f, cursor, limit: 200 });
        rows = reset ? res.rows : rows.concat(res.rows);
        cursor = res.nextCursor || 0;
        table.setRows(rows);
        pager.innerHTML = "";
        if (res.nextCursor) pager.appendChild(btn("Load more", null, { onClick: () => load(false) }));
      } catch (e) { toastErr(e.message); }
    });
  }

  const runBtn = btn("Run", "search", { primary: true, onClick: () => load(true) });
  const actions = [];
  if (can("export_audit")) {
    const cols = ["timestamp", "userEmail", "role", "action", "targetType", "targetId", "summary", "result"];
    actions.push(btn("CSV", "download", { onClick: () => exportCSV("audit-log", cols, rows) }));
    actions.push(btn("Excel", "download", { onClick: () => exportXLSX("audit-log", cols, rows, "Audit") }));
  }

  load(true);

  return h("div.stack", [
    pageHead("Audit Log", actions),
    card(null, h("div.stack", [filters.el, h("div", runBtn)])),
    card(null, h("div", [tableHost, pager])),
  ]);
}

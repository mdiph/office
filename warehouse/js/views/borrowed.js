import { h } from "../util/dom.js";
import { call } from "../api.js";
import { can } from "../store.js";
import { pageHead, card, btn, statusBadge } from "./_shared.js";
import { dataTable } from "../components/table.js";
import { fmtDate } from "../util/dates.js";
import { exportCSV, exportXLSX, printSection } from "../util/export.js";
import { openReturnForBorrow } from "./returns.js";

export async function viewBorrowed() {
  const { rows } = await call("listBorrowed");

  const onlyOverdue = h("input", { type: "checkbox" });
  const search = h("input.input--search", { type: "search", placeholder: "Search borrower, item, dept…" });

  const table = dataTable({
    columns: [
      { key: "itemName", label: "Item", wrap: true, render: (r) => h("a", { href: `#/item/${encodeURIComponent(r.itemCode)}`, text: r.itemName }) },
      { key: "unitId", label: "Unit", render: (r) => r.unitId ? h("span.mono", { text: r.unitId }) : `×${r.outstanding}` },
      { key: "borrower", label: "Borrower" },
      { key: "department", label: "Dept" },
      { key: "project", label: "Project", render: (r) => r.project || "—" },
      { key: "purpose", label: "Purpose", wrap: true },
      { key: "borrowDate", label: "Borrowed", render: (r) => fmtDate(r.borrowDate) },
      { key: "expectedReturnDate", label: "Due", render: (r) => fmtDate(r.expectedReturnDate) },
      { key: "overdue", label: "Status", render: (r) => r.overdue ? h("span.badge.badge--err", { text: "Overdue" }) : h("span.badge.badge--info", { text: "Out" }) },
      { key: "_a", label: "", sortable: false, render: (r) => can("return")
        ? btn("Return", "return", { sm: true, onClick: () => openReturnForBorrow(r, () => location.reload()) })
        : "" },
    ],
    rows: [],
    emptyText: "Nothing is currently borrowed.",
    responsiveCards: true,
    cardTitle: (r) => `${r.itemName} — ${r.borrower}`,
    rowClass: (r) => r.overdue ? "is-overdue" : "",
  });

  function apply() {
    const q = search.value.trim().toLowerCase();
    let list = rows.slice();
    if (onlyOverdue.checked) list = list.filter((r) => r.overdue);
    if (q) list = list.filter((r) => [r.itemName, r.borrower, r.department, r.project, r.slipNo].join(" ").toLowerCase().includes(q));
    table.setRows(list);
  }
  [search, onlyOverdue].forEach((el) => el.addEventListener("input", apply));
  apply();

  const region = h("div", table.el);
  const actions = [
    btn("Print", "print", { onClick: () => printSection("Borrowed items", region) }),
  ];
  if (can("export")) {
    const cols = ["slipNo", "itemCode", "itemName", "unitId", "borrower", "employeeId", "department", "project", "purpose", "borrowDate", "expectedReturnDate", "outstanding", "overdue"];
    actions.push(btn("CSV", "download", { onClick: () => exportCSV("borrowed-items", cols, rows) }));
    actions.push(btn("Excel", "download", { onClick: () => exportXLSX("borrowed-items", cols, rows, "Borrowed") }));
  }

  return h("div.stack", [
    pageHead("Borrowed Items", actions),
    card(null, h("div.stack", [
      h("div.toolbar", [search, h("label", { style: "display:flex;gap:6px;align-items:center" }, [onlyOverdue, "Overdue only"])]),
      region,
    ])),
  ]);
}

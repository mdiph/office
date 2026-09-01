import { h, clear } from "../util/dom.js";
import { escapeHtml } from "../util/dom.js";

// dataTable({ columns, rows, rowKey, emptyText, pageSize, responsiveCards })
//   columns: [{ key, label, num, wrap, render(row)->Node|string, sortable }]
// Returns { el, setRows }.
export function dataTable(opts) {
  const {
    columns,
    rows: initialRows = [],
    emptyText = "Nothing to show.",
    pageSize = 50,
    responsiveCards = false,
    cardTitle,
    tallScroll = false,
  } = opts;

  let rows = initialRows;
  let sortKey = null;
  let sortDir = 1;
  let shown = pageSize;

  const wrap = h("div");
  const tableWrap = h(`div.table-wrap${responsiveCards ? ".responsive" : ""}${tallScroll ? ".table-wrap--tall" : ""}`);
  const cardList = h("div.cardlist");
  const pager = h("div.pager");
  wrap.append(tableWrap, responsiveCards ? cardList : document.createComment(""), pager);

  function sorted() {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    return [...rows].sort((a, b) => {
      let av = col.sortValue ? col.sortValue(a) : a[sortKey];
      let bv = col.sortValue ? col.sortValue(b) : b[sortKey];
      av = av ?? ""; bv = bv ?? "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
  }

  function cellNode(col, row) {
    const v = col.render ? col.render(row) : row[col.key];
    if (v instanceof Node) return v;
    return document.createTextNode(v === null || v === undefined ? "" : String(v));
  }

  function render() {
    const data = sorted();
    const page = data.slice(0, shown);
    clear(tableWrap); clear(cardList); clear(pager);

    if (!data.length) {
      tableWrap.appendChild(h("div.empty", { text: emptyText }));
      return;
    }

    const thead = h("thead", h("tr", columns.map((c) =>
      h(`th${c.num ? ".num" : ""}${c.wrap ? ".wrap" : ""}`, {
        style: c.sortable !== false ? "cursor:pointer;user-select:none" : "",
        onclick: c.sortable !== false ? () => {
          if (sortKey === c.key) sortDir *= -1; else { sortKey = c.key; sortDir = 1; }
          render();
        } : null,
        text: c.label + (sortKey === c.key ? (sortDir === 1 ? " ▲" : " ▼") : ""),
      })
    )));
    const tbody = h("tbody", page.map((row) =>
      h("tr", { class: opts.rowClass ? opts.rowClass(row) : "" },
        columns.map((c) => {
          const td = h(`td${c.num ? ".num" : ""}${c.wrap ? ".wrap" : ""}`);
          td.appendChild(cellNode(c, row));
          return td;
        }))
    ));
    tableWrap.appendChild(h("table.tbl", [thead, tbody]));

    if (responsiveCards) {
      page.forEach((row) => {
        const rec = h("div.rec");
        rec.appendChild(h("b", { text: cardTitle ? cardTitle(row) : "" }));
        columns.forEach((c) => {
          if (c.hideCard) return;
          const val = c.render ? c.render(row) : row[c.key];
          const kv = h("div.kv", [h("span", { text: c.label }), h("span")]);
          const valEl = kv.lastChild;
          if (val instanceof Node) valEl.appendChild(val.cloneNode(true));
          else valEl.textContent = val ?? "";
          rec.appendChild(kv);
        });
        cardList.appendChild(rec);
      });
    }

    if (shown < data.length) {
      pager.appendChild(h("button.btn", {
        text: `Load more (${data.length - shown} more)`,
        onclick: () => { shown += pageSize; render(); },
      }));
    }
  }

  render();
  return {
    el: wrap,
    setRows(next) { rows = next; shown = pageSize; render(); },
    getRows() { return rows; },
  };
}

export { escapeHtml };

// CSV + XLSX export. XLSX uses the vendored SheetJS (window.XLSX) if present,
// otherwise falls back to CSV.

function cell(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

export function toCSV(columns, rows) {
  const esc = (s) => {
    s = cell(s);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(esc).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c])).join(",")).join("\n");
  return "﻿" + head + "\n" + body;
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCSV(baseName, columns, rows) {
  downloadBlob(`${baseName}.csv`, new Blob([toCSV(columns, rows)], { type: "text/csv;charset=utf-8" }));
}

export function exportXLSX(baseName, columns, rows, sheetName = "Data") {
  if (!window.XLSX) {
    exportCSV(baseName, columns, rows);
    return false;
  }
  const aoa = [columns, ...rows.map((r) => columns.map((c) => (r[c] ?? "")))];
  const ws = window.XLSX.utils.aoa_to_sheet(aoa);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  window.XLSX.writeFile(wb, `${baseName}.xlsx`);
  return true;
}

// Print `node` by cloning it into an in-page portal that the print stylesheet
// shows while hiding the rest of the app. No popup window (browsers block/blank those).
export function printSection(titleText, node) {
  document.querySelectorAll(".print-portal").forEach((e) => e.remove());

  const portal = document.createElement("div");
  portal.className = "print-portal";

  const title = document.createElement("h1");
  title.textContent = titleText;
  const meta = document.createElement("div");
  meta.className = "print-portal__meta";
  meta.textContent = "Generated " + new Date().toLocaleString();

  const content = node.cloneNode(true);
  // expand any scroll containers and "load more" truncation for print
  content.querySelectorAll(".table-wrap").forEach((w) => (w.style.overflow = "visible"));
  content.querySelectorAll(".pager, .toolbar, button").forEach((e) => e.remove());

  portal.append(title, meta, content);
  document.body.appendChild(portal);
  document.body.classList.add("is-printing");

  const cleanup = () => {
    document.body.classList.remove("is-printing");
    portal.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Fallback for browsers that don't fire afterprint reliably
  setTimeout(() => {
    try { window.print(); } catch (e) {}
    setTimeout(cleanup, 1000);
  }, 60);
}

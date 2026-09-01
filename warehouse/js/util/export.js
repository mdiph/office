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

export function printSection(titleText, node) {
  const holder = document.createElement("div");
  holder.className = "print-region";
  const t = document.createElement("div");
  t.className = "print-title";
  t.textContent = titleText;
  const m = document.createElement("div");
  m.className = "print-meta";
  m.textContent = "Generated " + new Date().toLocaleString();
  holder.append(t, m, node.cloneNode(true));
  const w = window.open("", "_blank");
  w.document.write(`<!doctype html><title>${titleText}</title>`);
  w.document.write('<link rel="stylesheet" href="' + location.origin + location.pathname.replace(/[^/]*$/, "") + 'css/tokens.css">');
  w.document.write('<link rel="stylesheet" href="' + location.origin + location.pathname.replace(/[^/]*$/, "") + 'css/app.css">');
  w.document.body.appendChild(holder);
  w.document.querySelectorAll(".print-title,.print-meta").forEach((e) => (e.style.display = "block"));
  setTimeout(() => { w.print(); }, 250);
}

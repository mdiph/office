// Date helpers. All "date only" values are ISO yyyy-mm-dd strings.

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDate(iso) {
  if (!iso) return "";
  const s = String(iso).slice(0, 10);
  const d = new Date(s + "T00:00:00");
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

export function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Overdue if expected + grace < today (date-only comparison).
export function isOverdue(expectedISO, graceDays = 0) {
  if (!expectedISO) return false;
  const cutoff = addDaysISO(String(expectedISO).slice(0, 10), graceDays);
  return cutoff < todayISO();
}

export function daysBetween(aISO, bISO) {
  const a = new Date(String(aISO).slice(0, 10) + "T00:00:00");
  const b = new Date(String(bISO).slice(0, 10) + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

function pad(n) { return String(n).padStart(2, "0"); }

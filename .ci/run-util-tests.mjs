// Headless run of the pure-utility tests (same assertions as warehouse/tests.html).
import { escapeHtml } from "../warehouse/js/util/dom.js";
import { addDaysISO, daysBetween, isOverdue, todayISO, fmtDate } from "../warehouse/js/util/dates.js";
import { toCSV } from "../warehouse/js/util/export.js";

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : " FAIL  ") + m); c ? pass++ : fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

eq(escapeHtml('<b>&"'), "&lt;b&gt;&amp;&quot;", "escapeHtml");
eq(escapeHtml(null), "", "escapeHtml null");
eq(addDaysISO("2026-01-01", 31), "2026-02-01", "addDaysISO month cross");
eq(addDaysISO("2026-03-01", -1), "2026-02-28", "addDaysISO negative");
eq(daysBetween("2026-01-01", "2026-01-15"), 14, "daysBetween");
ok(/^\d{4}-\d{2}-\d{2}$/.test(todayISO()), "todayISO format");
ok(isOverdue("2000-01-01", 0) === true, "isOverdue past");
ok(isOverdue("2999-01-01", 0) === false, "isOverdue future");
ok(isOverdue("", 0) === false, "isOverdue empty");
ok(fmtDate("2026-09-01").length > 0, "fmtDate renders");

const csv = toCSV(["a", "b"], [{ a: "x,y", b: 'say "hi"' }]);
ok(csv.startsWith("﻿"), "CSV BOM");
ok(csv.includes('"x,y"'), "CSV quotes commas");
ok(csv.includes('"say ""hi"""'), "CSV escapes quotes");

console.log(fail ? `\n${fail} FAILED` : `\nALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);

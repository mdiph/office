import { h } from "../util/dom.js";

// Thin wrapper over the vendored Chart.js (window.Chart). Degrades gracefully.
const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#0891b2", "#7c3aed", "#64748b", "#db2777"];

function box() { return h("div.chart-box"); }

function fallback(text) {
  const b = box();
  b.appendChild(h("div.chart-fallback", { text: text || "Chart unavailable" }));
  return b;
}

export function barChart({ labels, values, label = "Count", horizontal = false }) {
  if (!window.Chart) return fallback("Charts unavailable (Chart.js not loaded)");
  const b = box();
  const canvas = h("canvas");
  b.appendChild(canvas);
  new window.Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ label, data: values, backgroundColor: PALETTE[0] }] },
    options: {
      indexAxis: horizontal ? "y" : "x",
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { grid: { display: !horizontal } }, y: { beginAtZero: true } },
    },
  });
  return b;
}

export function doughnutChart({ labels, values }) {
  if (!window.Chart) return fallback("Charts unavailable");
  const b = box();
  const canvas = h("canvas");
  b.appendChild(canvas);
  new window.Chart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data: values, backgroundColor: PALETTE }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right" } } },
  });
  return b;
}

export function stackedBar({ labels, series }) {
  // series: [{ label, data: [] }]
  if (!window.Chart) return fallback("Charts unavailable");
  const b = box();
  const canvas = h("canvas");
  b.appendChild(canvas);
  new window.Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: series.map((s, i) => ({ label: s.label, data: s.data, backgroundColor: PALETTE[i % PALETTE.length] })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" } },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
    },
  });
  return b;
}

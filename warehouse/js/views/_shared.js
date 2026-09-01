import { h } from "../util/dom.js";
import { icon } from "../util/icons.js";

export function pageHead(title, actions) {
  return h("div.toolbar", [
    h("h1", { text: title, style: "margin:0" }),
    h("div.toolbar__spacer"),
    ...(actions || []),
  ]);
}

export function card(title, bodyNode, headActions) {
  const c = h("div.card");
  if (title) c.appendChild(h("div.card__head", [h("span", { text: title }), headActions || h("span")]));
  c.appendChild(h("div.card__body", [bodyNode]));
  return c;
}

const STATUS_KIND = {
  Available: "ok",
  Borrowed: "info",
  "Issued-out": "info",
  "Under inspection": "warn",
  Maintenance: "warn",
  Retired: "mut",
  Lost: "err",
};

export function statusBadge(status) {
  return h(`span.badge.badge--${STATUS_KIND[status] || "mut"}`, { text: status || "—" });
}

export function conditionBadge(cond) {
  const kind = cond === "Damaged" || cond === "Needs repair" ? "err"
    : cond === "Fair" || cond === "Incomplete" ? "warn" : "ok";
  return h(`span.badge.badge--${kind}`, { text: cond || "—" });
}

export function btn(label, iconName, opts = {}) {
  const b = h(`button.btn${opts.primary ? ".btn--primary" : ""}${opts.danger ? ".btn--danger" : ""}${opts.sm ? ".btn--sm" : ""}`);
  if (iconName) b.appendChild(icon(iconName, opts.sm ? 14 : 15));
  b.appendChild(document.createTextNode(label));
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}

// Wrap an async submit button: shows spinner, disables, re-enables on failure.
export async function withBusy(button, fn) {
  const orig = button.textContent;
  button.disabled = true;
  const sp = h("span.btn__spinner");
  button.prepend(sp);
  try {
    await fn();
  } finally {
    button.disabled = false;
    sp.remove();
    button.textContent = orig;
  }
}

export function photoUrl(fileId) {
  if (!fileId) return null;
  if (String(fileId).startsWith("data:") || String(fileId).startsWith("http")) return fileId;
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w400`;
}

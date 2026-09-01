import { h } from "../util/dom.js";
import { icon } from "../util/icons.js";

let host;
function ensureHost() {
  if (!host) {
    host = h("div.toast-host");
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message, kind = "ok", timeout) {
  ensureHost();
  const wrap = h(`div.toast.toast--${kind}`, [
    h("span", { style: "display:flex" }, icon(kind === "err" ? "warning" : kind === "info" ? "list" : "check", 16)),
    h("div.toast__msg", { text: message }),
    h("button.toast__x", { text: "×", onclick: () => wrap.remove() }),
  ]);
  host.appendChild(wrap);
  const t = timeout ?? (kind === "err" ? 0 : 3200);
  if (t) setTimeout(() => wrap.remove(), t);
}

export const toastOk = (m) => toast(m, "ok");
export const toastErr = (m) => toast(m, "err");
export const toastInfo = (m) => toast(m, "info");

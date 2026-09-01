// Tiny DOM helpers. No framework.

export function escapeHtml(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// h("div.card", {onclick}, [children]) style hyperscript.
export function h(tag, props, children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props && (Array.isArray(props) || typeof props === "string" || props instanceof Node)) {
    children = props;
    props = null;
  }
  if (props) {
    for (const [k, val] of Object.entries(props)) {
      if (val === null || val === undefined || val === false) continue;
      if (k === "class") el.className += " " + val;
      else if (k === "html") el.innerHTML = val;
      else if (k === "text") el.textContent = val;
      else if (k === "dataset") Object.assign(el.dataset, val);
      else if (k.startsWith("on") && typeof val === "function") el.addEventListener(k.slice(2), val);
      else if (k in el && k !== "list") { try { el[k] = val; } catch { el.setAttribute(k, val); } }
      else el.setAttribute(k, val);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  if (children === null || children === undefined) return el;
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function mount(el, node) { clear(el); el.appendChild(node); }

export function qs(sel, root = document) { return root.querySelector(sel); }

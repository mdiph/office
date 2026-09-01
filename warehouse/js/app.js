import { h, clear, mount } from "./util/dom.js";
import { icon } from "./util/icons.js";
import { setAuthExpiredHandler, setNetworkStateHandler, ping } from "./api.js";
import { loadSession, clearSession, currentUser, role, can, getConfig, getInventory } from "./store.js";
import { renderLogin, logout, openChangePassword } from "./auth.js";
import { toastErr } from "./components/toast.js";
import { CONFIG } from "../config.js";

import { viewDashboard } from "./views/dashboard.js";
import { viewInventory, viewItemDetail } from "./views/inventory.js";
import { viewReceive } from "./views/receive.js";
import { viewIssue } from "./views/issue.js";
import { viewBorrow } from "./views/borrow.js";
import { viewBorrowed } from "./views/borrowed.js";
import { viewReturns } from "./views/returns.js";
import { viewHistory } from "./views/history.js";
import { viewReports } from "./views/reports.js";
import { viewAudit } from "./views/audit.js";
import { viewUsers } from "./views/users.js";
import { viewSettings } from "./views/settings.js";

const ROUTES = [
  { path: "dashboard", label: "Dashboard", icon: "dashboard", cap: "view", render: viewDashboard },
  { path: "inventory", label: "Inventory", icon: "box", cap: "view", render: viewInventory },
  { path: "receive", label: "Receive", icon: "arrow-in", cap: "receive", render: viewReceive },
  { path: "issue", label: "Issue / Outgoing", icon: "arrow-out", cap: "view", render: viewIssue },
  { path: "borrow", label: "Borrow", icon: "borrow", cap: "borrow", render: viewBorrow },
  { path: "borrowed", label: "Borrowed Items", icon: "list", cap: "view", render: viewBorrowed },
  { path: "returns", label: "Returns", icon: "return", cap: "return", render: viewReturns },
  { path: "history", label: "Item History", icon: "history", cap: "view", render: viewHistory },
  { path: "reports", label: "Reports & Export", icon: "chart", cap: "view", render: viewReports },
  { path: "audit", label: "Audit Log", icon: "shield", cap: "audit", render: viewAudit },
  { path: "users", label: "Users", icon: "users", cap: "users", render: viewUsers },
  { path: "settings", label: "Settings", icon: "settings", cap: "view", render: viewSettings },
];
const HIDDEN = { "item": viewItemDetail }; // #/item/CODE detail route

const appEl = document.getElementById("app");
let shell = null;

function parseHash() {
  const raw = (location.hash || "#/dashboard").replace(/^#\/?/, "");
  const [path, ...rest] = raw.split("/");
  return { path: path || "dashboard", args: rest };
}

function buildShell() {
  const user = currentUser();
  const nav = h("nav.sidebar__nav");
  ROUTES.forEach((r) => {
    if (r.cap && !can(r.cap)) return;
    const link = h("a.sidebar__link", { href: `#/${r.path}`, dataset: { path: r.path } }, [icon(r.icon), r.label]);
    nav.appendChild(link);
  });

  const sidebar = h("aside.sidebar", [
    h("div.sidebar__brand", [icon("box", 20), "Warehouse"]),
    nav,
    h("div.sidebar__foot", [
      h("b", { text: user.name }),
      h("span", { text: user.role }),
      h("div", { style: "margin-top:8px;display:flex;gap:8px" }, [
        h("a.sidebar__link", { style: "padding:4px 0", onclick: (e) => { e.preventDefault(); openChangePassword(); }, href: "#" }, "Password"),
        h("a.sidebar__link", { style: "padding:4px 0", onclick: (e) => { e.preventDefault(); logout(); }, href: "#" }, [icon("logout", 15), "Sign out"]),
      ]),
    ]),
  ]);

  const title = h("div.topbar__title");
  const hamburger = h("button.topbar__hamburger", { onclick: () => sidebar.classList.toggle("is-open") }, icon("menu", 22));
  const content = h("div.content");
  const offline = h("div.banner-offline", { text: "Cannot reach the server — retrying…", style: "display:none" });

  const layout = h("div.layout", [
    sidebar,
    h("div.main", [
      offline,
      h("header.topbar", [hamburger, title]),
      content,
    ]),
  ]);

  sidebar.addEventListener("click", (e) => {
    if (e.target.closest(".sidebar__link[href^='#/']")) sidebar.classList.remove("is-open");
  });

  mount(appEl, layout);
  return { content, title, sidebar, offline };
}

function highlightNav(path) {
  shell.sidebar.querySelectorAll(".sidebar__link").forEach((a) => {
    a.classList.toggle("is-active", a.dataset.path === path);
  });
}

async function route() {
  if (!loadSession()) {
    renderLogin(appEl, () => { location.hash = "#/dashboard"; boot(); });
    return;
  }
  if (!shell) shell = buildShell();

  const { path, args } = parseHash();

  if (HIDDEN[path]) {
    shell.title.textContent = "Item detail";
    highlightNav("inventory");
    return renderInto(HIDDEN[path], args);
  }

  const r = ROUTES.find((x) => x.path === path) || ROUTES[0];
  if (r.cap && !can(r.cap)) {
    shell.content.innerHTML = "";
    shell.content.appendChild(h("div.empty", { text: "You do not have access to this page." }));
    return;
  }
  shell.title.textContent = r.label;
  highlightNav(r.path);
  renderInto(r.render, args);
}

async function renderInto(fn, args) {
  const { content } = shell;
  clear(content);
  const loading = h("div.stack", [h("div.skeleton", { style: "width:40%;height:22px" }),
    h("div.skeleton", { style: "height:120px" }), h("div.skeleton", { style: "height:220px" })]);
  content.appendChild(loading);
  try {
    const node = await fn({ args, navigate: (hash) => (location.hash = hash) });
    clear(content);
    content.appendChild(node);
    content.scrollTop = 0;
    window.scrollTo(0, 0);
  } catch (e) {
    clear(content);
    content.appendChild(h("div.card", h("div.card__body", [
      h("h3", { text: "Something went wrong" }),
      h("p.muted", { text: e.message || String(e) }),
      h("button.btn", { text: "Retry", onclick: route }),
    ])));
    if (e.code !== "AUTH_EXPIRED") toastErr(e.message || "Failed to load");
  }
}

async function boot() {
  shell = null;
  clear(appEl);
  await route();
}

// ---- global handlers ----
setAuthExpiredHandler(() => {
  const back = location.hash || "#/dashboard";
  clearSession();
  shell = null;
  renderLogin(appEl, () => { location.hash = back; boot(); }, "Your session expired. Please sign in again.");
});

let offlineTimer = null;
setNetworkStateHandler((online) => {
  if (!shell) return;
  shell.offline.style.display = online ? "none" : "block";
  if (!online && !offlineTimer) {
    offlineTimer = setInterval(async () => {
      if (await ping()) { clearInterval(offlineTimer); offlineTimer = null; shell.offline.style.display = "none"; }
    }, 5000);
  }
});

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", boot);
if (document.readyState !== "loading") boot();

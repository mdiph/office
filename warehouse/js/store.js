import { CONFIG } from "../config.js";
import { call } from "./api.js";

// In-memory cache + session holder. Lists are refetched after any write.
const state = {
  session: null,     // { token, user: { email, name, role } }
  config: null,      // { categories, locations, statuses, conditions, roles, ... }
  inventory: null,   // { skus:[], units:[] }
};

// ---- session ----
export function loadSession() {
  try {
    const raw = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
    state.session = raw ? JSON.parse(raw) : null;
  } catch { state.session = null; }
  return state.session;
}

export function setSession(s) {
  state.session = s;
  try { localStorage.setItem(CONFIG.SESSION_STORAGE_KEY, JSON.stringify(s)); } catch {}
}

export function clearSession() {
  state.session = null;
  try { localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY); } catch {}
  state.config = null;
  state.inventory = null;
}

export function session() { return state.session; }
export function currentUser() { return state.session ? state.session.user : null; }
export function role() { return state.session ? state.session.user.role : null; }

// ---- RBAC (frontend mirror of the backend matrix; backend still enforces) ----
const CAPS = {
  view: ["Admin", "Warehouse Staff", "Engineer", "Viewer"],
  export: ["Admin", "Warehouse Staff", "Engineer"],
  export_audit: ["Admin"],
  inventory_write: ["Admin", "Warehouse Staff"],
  receive: ["Admin", "Warehouse Staff"],
  issue: ["Admin", "Warehouse Staff"],
  return: ["Admin", "Warehouse Staff"],
  borrow_self: ["Admin", "Warehouse Staff", "Engineer"],
  borrow_behalf: ["Admin", "Warehouse Staff"],
  users: ["Admin"],
  audit: ["Admin"],
  config_write: ["Admin"],
};

export function can(cap) {
  const r = role();
  return !!r && (CAPS[cap] || []).includes(r);
}

// ---- config ----
export async function getConfig(force) {
  if (state.config && !force) return state.config;
  state.config = await call("getConfig");
  return state.config;
}
export function config() { return state.config; }

// ---- inventory ----
export async function getInventory(force) {
  if (state.inventory && !force) return state.inventory;
  state.inventory = await call("listInventory");
  return state.inventory;
}
export function invalidateInventory() { state.inventory = null; }

export function skuName(code) {
  const inv = state.inventory;
  if (!inv) return code;
  const s = inv.skus.find((x) => x.itemCode === code);
  return s ? s.name : code;
}

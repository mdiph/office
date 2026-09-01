// Apps Script backend client. Speaks {action, token, payload} over a single POST
// with Content-Type: text/plain (avoids the CORS preflight that GAS can't answer).

import { CONFIG, apiBase } from "../config.js";

export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

let onAuthExpired = () => {};
export function setAuthExpiredHandler(fn) { onAuthExpired = fn; }

let onNetworkState = () => {};
export function setNetworkStateHandler(fn) { onNetworkState = fn; }

function getToken() {
  try {
    const raw = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw).token : null;
  } catch { return null; }
}

export async function call(action, payload = {}) {
  const body = JSON.stringify({
    action,
    token: getToken(),
    payload,
    userAgent: navigator.userAgent,
  });

  let res;
  try {
    res = await fetch(apiBase(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow",
    });
    onNetworkState(true);
  } catch (e) {
    onNetworkState(false);
    throw new ApiError("NETWORK", "Cannot reach the server. Check your connection.");
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("BAD_RESPONSE", "The server returned an unexpected response.");
  }

  if (json && json.ok) return json.data;

  const err = (json && json.error) || { code: "UNKNOWN", message: "Unknown error." };
  if (err.code === "AUTH_EXPIRED") {
    onAuthExpired();
  }
  throw new ApiError(err.code, err.message);
}

export async function ping() {
  try {
    await call("ping");
    return true;
  } catch (e) {
    return e.code !== "NETWORK";
  }
}

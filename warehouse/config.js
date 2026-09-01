// Warehouse Management — frontend configuration.
//
// API_MODE:
//   "mock" -> talk to the local Python mock backend (warehouse/mock-server/server.py)
//   "prod" -> talk to the deployed Google Apps Script web app
//
// Flip this to "prod" after you have deployed the Apps Script backend and pasted
// its /exec URL into GAS_WEB_APP_URL below.

export const CONFIG = {
  API_MODE: "mock",

  MOCK_API_URL: "http://localhost:3000",

  // Paste your Apps Script web-app deployment URL here (ends with /exec):
  GAS_WEB_APP_URL: "https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXX/exec",

  APP_NAME: "Warehouse Management",
  SESSION_STORAGE_KEY: "wms.session",
  PAGE_SIZE: 50,
};

export function apiBase() {
  return CONFIG.API_MODE === "prod" ? CONFIG.GAS_WEB_APP_URL : CONFIG.MOCK_API_URL;
}

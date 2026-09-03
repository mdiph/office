// Warehouse Management — frontend configuration.
//
// Deploy the Google Apps Script backend (see warehouse/README.md), then paste
// its web-app URL (ends with /exec) into GAS_WEB_APP_URL below.

export const CONFIG = {
  // Apps Script web-app deployment URL:
  GAS_WEB_APP_URL: "https://script.google.com/macros/s/AKfycbxLD3DWyQmmE95jYJnTCbE5AQ3d5LpfDf2zjqdvoq4xWdFgmH_H4DdJiIRdIUlpcbBrow/exec",

  APP_NAME: "Warehouse Management",
  SESSION_STORAGE_KEY: "wms.session",
  PAGE_SIZE: 50,
};

export function apiBase() {
  return CONFIG.GAS_WEB_APP_URL;
}

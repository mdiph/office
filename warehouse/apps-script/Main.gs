/** HTTP entry points + request router. */

function doGet() {
  return _json({ ok: true, data: { pong: true, schemaVersion: SCHEMA_VERSION } });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return _json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } });
  }
  var action = body.action;
  var payload = body.payload || {};
  var ctx = { token: body.token || null, userAgent: body.userAgent || '' };

  try {
    if (action === 'ping') return _json({ ok: true, data: { pong: true, schemaVersion: SCHEMA_VERSION } });
    if (action === 'login') return _json({ ok: true, data: handleLogin_(payload, ctx) });

    var handler = ROUTER[action];
    if (!handler) throw new ApiError('UNKNOWN_ACTION', 'Unknown action: ' + action);

    checkSchema_();
    var user = authenticate_(ctx.token, ctx);
    var data = handler(user, payload, ctx);
    return _json({ ok: true, data: data });
  } catch (err) {
    var code = err && err.code ? err.code : 'SERVER';
    var message = err && err.message ? err.message : String(err);
    if (code === 'SERVER') console.error(err && err.stack ? err.stack : err);
    return _json({ ok: false, error: { code: code, message: message } });
  }
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkSchema_() {
  var v = parseInt(configMap_()['schemaVersion'] || '0', 10);
  if (v !== SCHEMA_VERSION) {
    throw new ApiError('SCHEMA', 'Backend schema v' + SCHEMA_VERSION + ' but sheet is v' + v + '. Run setup()/migrate.');
  }
}

function require_(role, cap) {
  var allowed = CAPS[cap] || [];
  if (allowed.indexOf(role) === -1) throw new ApiError('FORBIDDEN', 'Your role does not permit this action.');
}

function audit_(ctx, userEmail, role, action, targetType, targetId, summary, result) {
  try {
    appendRow_('AuditLog', {
      auditId: uuid_(), timestamp: nowIso_(), userEmail: userEmail || '', role: role || '',
      action: action, targetType: targetType, targetId: targetId, summary: summary,
      userAgent: (ctx && ctx.userAgent) || '', result: result || 'success'
    });
  } catch (e) {
    console.warn('audit append failed: ' + e);
  }
}

var ROUTER = {
  logout: handleLogout_,
  session: handleSession_,
  changePassword: handleChangePassword_,

  listUsers: handleListUsers_,
  createUser: handleCreateUser_,
  updateUser: handleUpdateUser_,
  resetPassword: handleResetPassword_,
  forceLogout: handleForceLogout_,

  getConfig: handleGetConfig_,
  updateConfig: handleUpdateConfig_,
  addCategory: handleAddCategory_,
  renameCategory: handleRenameCategory_,
  deleteCategory: handleDeleteCategory_,
  addLocation: handleAddLocation_,
  renameLocation: handleRenameLocation_,
  deleteLocation: handleDeleteLocation_,

  listInventory: handleListInventory_,
  getItem: handleGetItem_,
  createSku: handleCreateSku_,
  updateSku: handleUpdateSku_,
  deleteSku: handleDeleteSku_,
  addUnits: handleAddUnits_,
  updateUnit: handleUpdateUnit_,

  receive: handleReceive_,
  issue: handleIssue_,
  borrow: handleBorrow_,
  returnItems: handleReturn_,
  clearInspection: handleClearInspection_,

  itemHistory: handleItemHistory_,
  listBorrowed: handleListBorrowed_,
  listTransactions: handleListTransactions_,
  getDashboard: handleGetDashboard_,

  exportData: handleExportData_,
  listAudit: handleListAudit_,
  uploadImage: handleUploadImage_
};

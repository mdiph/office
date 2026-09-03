/**
 * Warehouse Management — Google Apps Script backend (whole backend, one file).
 *
 * One doPost(e) entry point (see the Main section) routes {action, token, payload}.
 * Sections, in load order: Config, Sheets, Crypto, Auth, Inventory, Transactions,
 * Dashboard, Reports, AuditAndImages, Setup, Main, Tests.
 *
 * SETUP — no Script Properties, no IDs to paste anywhere:
 *   1. Open your Google Sheet → Extensions → Apps Script. Paste this file in.
 *      (Creating the project this way BINDS it to that sheet.)
 *   2. Optionally edit the Config constants just below.
 *   3. Run setup() once and grant the permission prompts. It builds the tabs,
 *      generates a password secret (kept in the Config tab), installs triggers,
 *      and creates the first admin from BOOTSTRAP_ADMIN_EMAIL / _PASSWORD.
 *      Sign in and change that password immediately.
 *   4. Deploy → New deployment → Web app (Execute as: Me, Access: Anyone).
 *      Put the /exec URL into warehouse/config.js.
 *   5. In the app: Settings → add your Categories and Locations, then Receive stock.
 *
 * runAllTests() self-checks on a throwaway sheet it deletes afterward.
 */

// ===== Config ================================================================

// ── edit these ──────────────────────────────────────────────────────────────
var PHOTO_FOLDER_NAME        = 'Warehouse Photos';   // Drive folder for product photos — created if missing
var HASH_ITERATIONS          = 2000;                 // Apps Script runs HMAC in an interpreted loop — keep this modest (1000–3000). Each stored hash records its own count, so changing this only affects new/reset passwords (see resetAdmin()).
var BOOTSTRAP_ADMIN_EMAIL    = 'admin@warehouse.local';
var BOOTSTRAP_ADMIN_PASSWORD = 'ChangeMe123!';       // used only by setup(); change it right after first sign-in
// ────────────────────────────────────────────────────────────────────────────

var SCHEMA_VERSION = 1;

var SESSION_IDLE_MS = 8 * 60 * 60 * 1000;    // 8h sliding idle
var SESSION_ABS_MS  = 24 * 60 * 60 * 1000;   // 24h absolute
var MAX_FAILED_LOGINS = 5;
var LOCK_MINUTES = 15;
var EXPORT_CAP = 50000;
var LOCK_TIMEOUT_MS = 25000;

var STATUSES = ['Available', 'Borrowed', 'Under inspection', 'Maintenance', 'Retired', 'Lost'];
// Units in these statuses no longer count as live stock (they stay in the sheet for records).
// A permanent issue does not use a status — the unit row is deleted; the ISSUE transaction is the record.
var TERMINAL_STATUSES = ['Retired', 'Lost'];
var CONDITIONS = ['New', 'Good', 'Fair', 'Damaged', 'Needs repair', 'Incomplete'];
var ROLES = ['Admin', 'Warehouse Staff', 'Engineer', 'Viewer'];

// Capability -> roles allowed. Mirrored (loosely) on the frontend; this is authoritative.
var CAPS = {
  view:            ['Admin', 'Warehouse Staff', 'Engineer', 'Viewer'],
  export:          ['Admin', 'Warehouse Staff', 'Engineer'],
  export_audit:    ['Admin'],
  inventory_write: ['Admin', 'Warehouse Staff'],
  receive:         ['Admin', 'Warehouse Staff'],
  issue:           ['Admin', 'Warehouse Staff'],
  return:          ['Admin', 'Warehouse Staff'],
  borrow_self:     ['Admin', 'Warehouse Staff', 'Engineer'],
  borrow_behalf:   ['Admin', 'Warehouse Staff'],
  users:           ['Admin'],
  audit:           ['Admin'],
  config_write:    ['Admin']
};

var SHEETS = {
  Users:        ['email', 'name', 'role', 'active', 'passwordHash', 'failedCount', 'lockedUntil', 'createdAt', 'createdBy'],
  Sessions:     ['token', 'userEmail', 'createdAt', 'lastSeenAt', 'userAgent'],
  Inventory:    ['itemCode', 'name', 'category', 'brand', 'model', 'specification', 'description', 'trackingType', 'quantityOnHand', 'photoFileId', 'active', 'createdAt', 'createdBy'],
  Units:        ['unitId', 'itemCode', 'serialNumber', 'condition', 'status', 'location', 'currentHolder', 'photoFileId', 'createdAt'],
  Transactions: ['txnId', 'slipNo', 'timestamp', 'txnDate', 'type', 'itemCode', 'unitId', 'qty', 'qtyDamaged', 'fromLocation', 'toLocation', 'party', 'employeeId', 'department', 'project', 'purpose', 'destination', 'expectedReturnDate', 'actualReturnDate', 'condition', 'requiresInspection', 'notes', 'processedBy', 'linkedTxnId'],
  AuditLog:     ['auditId', 'timestamp', 'userEmail', 'role', 'action', 'targetType', 'targetId', 'summary', 'userAgent', 'result'],
  Config:       ['key', 'value'],
  Categories:   ['name'],
  Locations:    ['code'],
  Counters:     ['key', 'value']
};

function ApiError(code, message) { this.code = code; this.message = message || code; }
ApiError.prototype = Object.create(Error.prototype);

// ===== Sheets ================================================================

/** Data-access layer over the Spreadsheet. Rows are plain objects keyed by SHEETS[name]. */

var _ssCache = null;
function ss_() {
  if (!_ssCache) {
    _ssCache = SpreadsheetApp.getActiveSpreadsheet();
    if (!_ssCache) throw new ApiError('CONFIG',
      'No bound spreadsheet. Create this script from inside the Sheet (Extensions → Apps Script).');
  }
  return _ssCache;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new ApiError('CONFIG', 'Missing sheet tab: ' + name + '. Run setup().');
  return sh;
}

function readAll_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var headers = SHEETS[name];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.join('') === '') continue;
    var obj = { _row: r + 1 };
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
    out.push(obj);
  }
  return out;
}

function appendRow_(name, obj) {
  var headers = SHEETS[name];
  var row = headers.map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
  sheet_(name).appendRow(row);
}

function updateRow_(name, rowNumber, obj) {
  var headers = SHEETS[name];
  var sh = sheet_(name);
  var row = headers.map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
  sh.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
}

function findRow_(name, predicate) {
  var all = readAll_(name);
  for (var i = 0; i < all.length; i++) if (predicate(all[i])) return all[i];
  return null;
}

// ---- typed helpers ----
function boolOf_(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1; }

function nextCounter_(key) {
  var rows = readAll_('Counters');
  var row = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) { row = rows[i]; break; }
  if (!row) {
    appendRow_('Counters', { key: key, value: 1 });
    return 1;
  }
  var next = Number(row.value || 0) + 1;
  updateRow_('Counters', row._row, { key: key, value: next });
  return next;
}

function configMap_() {
  var rows = readAll_('Config');
  var m = {};
  rows.forEach(function (r) { m[r.key] = r.value; });
  return m;
}
function setConfig_(key, value) {
  var row = findRow_('Config', function (r) { return r.key === key; });
  if (row) updateRow_('Config', row._row, { key: key, value: value });
  else appendRow_('Config', { key: key, value: value });
}

// Per-install password secret. Generated once by setup() and kept in the Config
// tab (never in code, never sent to a client — handleGetConfig_ whitelists keys).
var _pepperCache = null;
function pepper_() {
  if (_pepperCache === null) {
    _pepperCache = configMap_().pepper || '';
    if (!_pepperCache) throw new ApiError('CONFIG', 'Password secret missing — run setup().');
  }
  return _pepperCache;
}

function listCol_(name, col) {
  return readAll_(name).map(function (r) { return r[col]; }).filter(function (v) { return v !== '' && v !== null; });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function nowIso_() { return new Date().toISOString(); }
function todayStr_() {
  return Utilities.formatDate(new Date(), ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}
function uuid_() { return Utilities.getUuid(); }

// ===== Crypto ================================================================

/** Password hashing: PBKDF2-style iterated HMAC-SHA256 with per-user salt + server pepper. */

function _bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

function _hmac(keyBytes, msgBytes) {
  return Utilities.computeHmacSha256Signature(msgBytes, keyBytes);
}

function _deriveHex(password, saltHex, iterations) {
  var key = Utilities.newBlob(password + '|' + pepper_()).getBytes();
  var block = Utilities.newBlob(saltHex + '|seed').getBytes();
  var acc = _hmac(key, block);
  var out = acc;
  for (var i = 1; i < iterations; i++) {
    acc = _hmac(key, acc);
    for (var j = 0; j < out.length; j++) out[j] ^= acc[j];
  }
  return _bytesToHex(out);
}

function hashPassword_(password) {
  var iterations = HASH_ITERATIONS;
  var saltHex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
  var hex = _deriveHex(password, saltHex, iterations);
  return saltHex + ':' + iterations + ':' + hex;
}

function verifyPassword_(password, stored) {
  if (!stored) return false;
  var parts = String(stored).split(':');
  if (parts.length !== 3) return false;
  var saltHex = parts[0];
  var iterations = parseInt(parts[1], 10);
  var expected = parts[2];
  var actual = _deriveHex(password, saltHex, iterations);
  // constant-time-ish compare
  if (actual.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function randomToken_() {
  // 4 UUIDs -> 128 hex chars of entropy from Apps Script's UUID generator.
  return (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

// ===== Auth ==================================================================

/** Authentication, sessions, users. */

function userByEmail_(email) {
  email = String(email || '').toLowerCase();
  return findRow_('Users', function (r) { return String(r.email).toLowerCase() === email; });
}

function handleLogin_(payload, ctx) {
  var email = String(payload.email || '').trim().toLowerCase();
  var password = String(payload.password || '');

  // Read + verify OUTSIDE the script lock. The hash is a slow interpreted loop
  // and must not hold the lock while it runs — only the writes below need it.
  var user = userByEmail_(email);
  if (!user || !boolOf_(user.active)) {
    audit_(ctx, email, null, 'LOGIN', 'user', email, 'Unknown or inactive user', 'denied');
    throw new ApiError('AUTH_FAILED', 'Invalid credentials.');
  }
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    throw new ApiError('LOCKED', 'Account locked. Try again later.');
  }
  var okPw = verifyPassword_(password, user.passwordHash);

  return withLock_(function () {
    var fresh = userByEmail_(email) || user;
    if (!okPw) {
      var failed = Number(fresh.failedCount || 0) + 1;
      var patch = { failedCount: failed };
      if (failed >= MAX_FAILED_LOGINS) {
        patch.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
        patch.failedCount = 0;
      }
      _patchUser_(fresh, patch);
      audit_(ctx, email, fresh.role, 'LOGIN', 'user', email, 'Bad password', 'denied');
      throw new ApiError('AUTH_FAILED', 'Invalid credentials.');
    }
    _patchUser_(fresh, { failedCount: 0, lockedUntil: '' });

    var token = randomToken_();
    var ts = nowIso_();
    appendRow_('Sessions', { token: token, userEmail: fresh.email, createdAt: ts, lastSeenAt: ts, userAgent: ctx.userAgent });
    audit_(ctx, fresh.email, fresh.role, 'LOGIN', 'user', fresh.email, 'Login', 'success');
    return { token: token, user: { email: fresh.email, name: fresh.name, role: fresh.role } };
  });
}

function _patchUser_(user, patch) {
  var merged = {};
  SHEETS.Users.forEach(function (h) { merged[h] = user[h]; });
  Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
  updateRow_('Users', user._row, merged);
}

function authenticate_(token, ctx) {
  if (!token) throw new ApiError('AUTH_EXPIRED', 'Not signed in.');
  var sess = findRow_('Sessions', function (r) { return r.token === token; });
  if (!sess) throw new ApiError('AUTH_EXPIRED', 'Session not found. Please sign in again.');
  var now = Date.now();
  var created = new Date(sess.createdAt).getTime();
  var seen = new Date(sess.lastSeenAt).getTime();
  if (now - created > SESSION_ABS_MS || now - seen > SESSION_IDLE_MS) {
    sheet_('Sessions').deleteRow(sess._row);
    throw new ApiError('AUTH_EXPIRED', 'Session expired. Please sign in again.');
  }
  updateRow_('Sessions', sess._row, {
    token: sess.token, userEmail: sess.userEmail, createdAt: sess.createdAt,
    lastSeenAt: nowIso_(), userAgent: sess.userAgent
  });
  var user = userByEmail_(sess.userEmail);
  if (!user || !boolOf_(user.active)) throw new ApiError('AUTH_EXPIRED', 'User no longer active.');
  user._token = token;
  return user;
}

function handleLogout_(user, payload, ctx) {
  return withLock_(function () {
    var sess = findRow_('Sessions', function (r) { return r.token === user._token; });
    if (sess) sheet_('Sessions').deleteRow(sess._row);
    audit_(ctx, user.email, user.role, 'LOGOUT', 'user', user.email, 'Logout', 'success');
    return { ok: true };
  });
}

function handleSession_(user) {
  return { user: { email: user.email, name: user.name, role: user.role } };
}

function handleChangePassword_(user, payload, ctx) {
  // Hashing is slow — do it before taking the lock.
  var current = userByEmail_(user.email);
  if (!current || !verifyPassword_(String(payload.currentPassword || ''), current.passwordHash)) {
    throw new ApiError('AUTH_FAILED', 'Current password is incorrect.');
  }
  var np = String(payload.newPassword || '');
  if (np.length < 8) throw new ApiError('VALIDATION', 'New password must be at least 8 characters.');
  var newHash = hashPassword_(np);
  return withLock_(function () {
    var fresh = userByEmail_(user.email) || current;
    _patchUser_(fresh, { passwordHash: newHash });
    audit_(ctx, user.email, user.role, 'USER_CHANGE', 'user', user.email, 'Changed own password', 'success');
    return { ok: true };
  });
}

// ---- user management ----
function _userPublic_(u) {
  return { email: u.email, name: u.name, role: u.role, active: boolOf_(u.active), createdAt: u.createdAt };
}

function handleListUsers_(user) {
  require_(user.role, 'users');
  return { users: readAll_('Users').map(_userPublic_) };
}

function handleCreateUser_(user, payload, ctx) {
  require_(user.role, 'users');
  var email = String(payload.email || '').trim().toLowerCase();
  var name = String(payload.name || '').trim();
  var role = payload.role;
  var password = String(payload.password || '');
  if (!email || !name || ROLES.indexOf(role) === -1) throw new ApiError('VALIDATION', 'Name, email and a valid role are required.');
  if (password.length < 8) throw new ApiError('VALIDATION', 'Password must be at least 8 characters.');
  var newHash = hashPassword_(password); // slow — before the lock
  return withLock_(function () {
    if (userByEmail_(email)) throw new ApiError('CONFLICT', 'A user with that email already exists.');
    var rec = {
      email: email, name: name, role: role, active: true,
      passwordHash: newHash, failedCount: 0, lockedUntil: '',
      createdAt: nowIso_(), createdBy: user.email
    };
    appendRow_('Users', rec);
    audit_(ctx, user.email, user.role, 'USER_CHANGE', 'user', email, 'Created user (' + role + ')', 'success');
    return { user: _userPublic_(rec) };
  });
}

function handleUpdateUser_(user, payload, ctx) {
  require_(user.role, 'users');
  return withLock_(function () {
    var target = userByEmail_(payload.email);
    if (!target) throw new ApiError('NOT_FOUND', 'User not found.');
    var patch = {};
    var changes = [];
    if (payload.name) { patch.name = String(payload.name).trim(); changes.push('name'); }
    if (payload.role) {
      if (ROLES.indexOf(payload.role) === -1) throw new ApiError('VALIDATION', 'Invalid role.');
      patch.role = payload.role; changes.push('role');
    }
    if (payload.hasOwnProperty('active')) {
      patch.active = !!payload.active; changes.push('active');
      if (!payload.active) _deleteSessionsFor_(target.email);
    }
    _patchUser_(target, patch);
    audit_(ctx, user.email, user.role, 'USER_CHANGE', 'user', target.email, 'Updated ' + changes.join(', '), 'success');
    return { user: _userPublic_(userByEmail_(target.email)) };
  });
}

function handleResetPassword_(user, payload, ctx) {
  require_(user.role, 'users');
  var np = String(payload.newPassword || '');
  if (np.length < 8) throw new ApiError('VALIDATION', 'Password must be at least 8 characters.');
  var newHash = hashPassword_(np); // slow — before the lock
  return withLock_(function () {
    var target = userByEmail_(payload.email);
    if (!target) throw new ApiError('NOT_FOUND', 'User not found.');
    _patchUser_(target, { passwordHash: newHash, failedCount: 0, lockedUntil: '' });
    audit_(ctx, user.email, user.role, 'USER_CHANGE', 'user', target.email, 'Reset password', 'success');
    return { ok: true };
  });
}

function handleForceLogout_(user, payload, ctx) {
  require_(user.role, 'users');
  return withLock_(function () {
    var target = userByEmail_(payload.email);
    if (!target) throw new ApiError('NOT_FOUND', 'User not found.');
    _deleteSessionsFor_(target.email);
    audit_(ctx, user.email, user.role, 'USER_CHANGE', 'user', target.email, 'Forced logout', 'success');
    return { ok: true };
  });
}

function _deleteSessionsFor_(email) {
  var sh = sheet_('Sessions');
  var rows = readAll_('Sessions').filter(function (r) { return String(r.userEmail).toLowerCase() === String(email).toLowerCase(); });
  rows.sort(function (a, b) { return b._row - a._row; });
  rows.forEach(function (r) { sh.deleteRow(r._row); });
}

/** Time-driven trigger: purge expired sessions. Install from setup(). */
function purgeSessions() {
  withLock_(function () {
    var sh = sheet_('Sessions');
    var now = Date.now();
    var rows = readAll_('Sessions').filter(function (r) {
      return now - new Date(r.createdAt).getTime() > SESSION_ABS_MS ||
             now - new Date(r.lastSeenAt).getTime() > SESSION_IDLE_MS;
    });
    rows.sort(function (a, b) { return b._row - a._row; });
    rows.forEach(function (r) { sh.deleteRow(r._row); });
  });
}

// ===== Inventory =============================================================

/** Config, vocabularies, SKU + Unit management. */

function handleGetConfig_() {
  var c = configMap_();
  return {
    categories: listCol_('Categories', 'name').sort(),
    locations: listCol_('Locations', 'code').sort(),
    lowStockThreshold: Number(c.lowStockThreshold || 5),
    overdueGraceDays: Number(c.overdueGraceDays || 0),
    statuses: STATUSES,
    conditions: CONDITIONS,
    roles: ROLES,
    brands: _distinct_(readAll_('Inventory').map(function (s) { return s.brand; })),
    models: _distinct_(readAll_('Inventory').map(function (s) { return s.model; }))
  };
}

function _distinct_(arr) {
  var seen = {}, out = [];
  arr.forEach(function (v) { v = String(v || '').trim(); if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
  return out.sort();
}

function handleUpdateConfig_(user, payload, ctx) {
  require_(user.role, 'config_write');
  return withLock_(function () {
    if (payload.hasOwnProperty('lowStockThreshold')) setConfig_('lowStockThreshold', Math.max(0, parseInt(payload.lowStockThreshold, 10) || 0));
    if (payload.hasOwnProperty('overdueGraceDays')) setConfig_('overdueGraceDays', Math.max(0, parseInt(payload.overdueGraceDays, 10) || 0));
    audit_(ctx, user.email, user.role, 'CONFIG', 'config', '-', 'Updated config', 'success');
    return handleGetConfig_();
  });
}

function handleAddCategory_(user, payload, ctx) {
  require_(user.role, 'config_write');
  var name = String(payload.name || '').trim();
  if (!name) throw new ApiError('VALIDATION', 'Category name required.');
  return withLock_(function () {
    if (listCol_('Categories', 'name').indexOf(name) === -1) appendRow_('Categories', { name: name });
    audit_(ctx, user.email, user.role, 'CONFIG', 'category', name, 'Added category', 'success');
    return { categories: listCol_('Categories', 'name').sort() };
  });
}

function handleRenameCategory_(user, payload, ctx) {
  require_(user.role, 'config_write');
  var oldName = payload.old;
  var newName = String(payload['new'] || '').trim();
  if (!newName) throw new ApiError('VALIDATION', 'New category name required.');
  return withLock_(function () {
    var row = findRow_('Categories', function (r) { return r.name === oldName; });
    if (!row) throw new ApiError('NOT_FOUND', 'Category not found.');
    if (newName !== oldName && listCol_('Categories', 'name').indexOf(newName) !== -1) {
      throw new ApiError('CONFLICT', 'A category with that name already exists.');
    }
    updateRow_('Categories', row._row, { name: newName });
    readAll_('Inventory').forEach(function (s) {
      if (s.category === oldName) {
        var merged = {};
        SHEETS.Inventory.forEach(function (h) { merged[h] = s[h]; });
        merged.category = newName;
        updateRow_('Inventory', s._row, merged);
      }
    });
    audit_(ctx, user.email, user.role, 'CONFIG', 'category', newName, 'Renamed category ' + oldName + ' -> ' + newName, 'success');
    return { categories: listCol_('Categories', 'name').sort() };
  });
}

function handleDeleteCategory_(user, payload, ctx) {
  require_(user.role, 'config_write');
  var name = payload.name;
  return withLock_(function () {
    var row = findRow_('Categories', function (r) { return r.name === name; });
    if (!row) throw new ApiError('NOT_FOUND', 'Category not found.');
    var inUse = readAll_('Inventory').filter(function (s) { return s.category === name; }).length;
    if (inUse) throw new ApiError('BLOCKED', 'Category is used by ' + inUse + ' item(s). Reassign them first.');
    sheet_('Categories').deleteRow(row._row);
    audit_(ctx, user.email, user.role, 'CONFIG', 'category', name, 'Deleted category', 'success');
    return { categories: listCol_('Categories', 'name').sort() };
  });
}

function handleAddLocation_(user, payload, ctx) {
  require_(user.role, 'config_write');
  var code = String(payload.code || '').trim().toUpperCase();
  if (!code) throw new ApiError('VALIDATION', 'Location code required.');
  return withLock_(function () {
    if (listCol_('Locations', 'code').indexOf(code) === -1) appendRow_('Locations', { code: code });
    audit_(ctx, user.email, user.role, 'CONFIG', 'location', code, 'Added location', 'success');
    return { locations: listCol_('Locations', 'code').sort() };
  });
}

function handleRenameLocation_(user, payload, ctx) {
  require_(user.role, 'config_write');
  var oldCode = payload.old;
  var newCode = String(payload['new'] || '').trim().toUpperCase();
  if (!newCode) throw new ApiError('VALIDATION', 'New location code required.');
  return withLock_(function () {
    var row = findRow_('Locations', function (r) { return r.code === oldCode; });
    if (!row) throw new ApiError('NOT_FOUND', 'Location not found.');
    if (newCode !== oldCode && listCol_('Locations', 'code').indexOf(newCode) !== -1) {
      throw new ApiError('CONFLICT', 'A location with that code already exists.');
    }
    updateRow_('Locations', row._row, { code: newCode });
    readAll_('Units').forEach(function (u) {
      if (u.location === oldCode) {
        var merged = {};
        SHEETS.Units.forEach(function (h) { merged[h] = u[h]; });
        merged.location = newCode;
        updateRow_('Units', u._row, merged);
      }
    });
    audit_(ctx, user.email, user.role, 'CONFIG', 'location', newCode, 'Renamed location ' + oldCode + ' -> ' + newCode, 'success');
    return { locations: listCol_('Locations', 'code').sort() };
  });
}

function handleDeleteLocation_(user, payload, ctx) {
  require_(user.role, 'config_write');
  var code = payload.code;
  return withLock_(function () {
    var row = findRow_('Locations', function (r) { return r.code === code; });
    if (!row) throw new ApiError('NOT_FOUND', 'Location not found.');
    var inUse = readAll_('Units').filter(function (u) { return u.location === code; }).length;
    if (inUse) throw new ApiError('BLOCKED', 'Location holds ' + inUse + ' unit(s). Move them first.');
    sheet_('Locations').deleteRow(row._row);
    audit_(ctx, user.email, user.role, 'CONFIG', 'location', code, 'Deleted location', 'success');
    return { locations: listCol_('Locations', 'code').sort() };
  });
}

// ---- read ----
function _skus_() {
  return readAll_('Inventory').map(function (s) {
    s.active = boolOf_(s.active);
    s.quantityOnHand = Number(s.quantityOnHand || 0);
    return s;
  });
}
function _units_() { return readAll_('Units'); }
function skuByCode_(code) { return findRow_('Inventory', function (r) { return r.itemCode === code; }); }
function unitsOf_(code) { return _units_().filter(function (u) { return u.itemCode === code; }); }

function handleListInventory_() {
  return { skus: _skus_(), units: _units_() };
}

function handleGetItem_(user, payload) {
  var sku = skuByCode_(payload.itemCode);
  if (!sku) throw new ApiError('NOT_FOUND', 'Item not found.');
  sku.active = boolOf_(sku.active);
  sku.quantityOnHand = Number(sku.quantityOnHand || 0);
  return {
    sku: sku,
    units: unitsOf_(payload.itemCode),
    history: _historyRows_(payload.itemCode, null)
  };
}

function _genSkuCode_(category) {
  var seq = nextCounter_('SKU');
  var prefix = String(category || 'GEN').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  while (prefix.length < 3) prefix += 'X';
  return 'WH-' + prefix + ('0000' + seq).slice(-4);
}

function _validCategory_(c) { return listCol_('Categories', 'name').indexOf(c) !== -1; }
function _validLocation_(l) { return listCol_('Locations', 'code').indexOf(l) !== -1; }

function handleCreateSku_(user, payload, ctx) {
  require_(user.role, 'inventory_write');
  return withLock_(function () { return _createSku_(user, payload, ctx); });
}

function _createSku_(user, payload, ctx) {
  var name = String(payload.name || '').trim();
  var category = String(payload.category || '').trim();
  var tracking = payload.trackingType;
  if (!name || !_validCategory_(category) || (tracking !== 'serialized' && tracking !== 'quantity')) {
    throw new ApiError('VALIDATION', 'Name, known category and tracking type are required.');
  }
  var code = String(payload.itemCode || '').trim() || _genSkuCode_(category);
  if (skuByCode_(code)) throw new ApiError('CONFLICT', 'Item code already exists.');
  var rec = {
    itemCode: code, name: name, category: category,
    brand: String(payload.brand || '').trim(), model: String(payload.model || '').trim(),
    specification: String(payload.specification || '').trim(), description: String(payload.description || '').trim(),
    trackingType: tracking, quantityOnHand: 0, photoFileId: payload.photoFileId || '',
    active: true, createdAt: nowIso_(), createdBy: user.email
  };
  appendRow_('Inventory', rec);
  audit_(ctx, user.email, user.role, 'ITEM_ADD', 'sku', code, 'Created SKU ' + name, 'success');
  rec.quantityOnHand = 0;
  return { sku: rec };
}

function handleUpdateSku_(user, payload, ctx) {
  require_(user.role, 'inventory_write');
  return withLock_(function () {
    var sku = skuByCode_(payload.itemCode);
    if (!sku) throw new ApiError('NOT_FOUND', 'Item not found.');
    var patch = payload.patch || {};
    var merged = {};
    SHEETS.Inventory.forEach(function (h) { merged[h] = sku[h]; });

    if (patch.hasOwnProperty('trackingType') && patch.trackingType !== sku.trackingType) {
      var hasTxn = _transactions_().some(function (t) { return t.itemCode === sku.itemCode; });
      if (hasTxn) throw new ApiError('BLOCKED', 'Cannot change tracking type once transactions exist.');
      merged.trackingType = patch.trackingType;
    }
    ['name', 'brand', 'model', 'specification', 'description', 'photoFileId'].forEach(function (f) {
      if (patch.hasOwnProperty(f)) merged[f] = patch[f] || '';
    });
    if (patch.hasOwnProperty('category')) {
      if (!_validCategory_(patch.category)) throw new ApiError('VALIDATION', 'Unknown category.');
      merged.category = patch.category;
    }
    updateRow_('Inventory', sku._row, merged);
    audit_(ctx, user.email, user.role, 'ITEM_EDIT', 'sku', sku.itemCode, 'Edited SKU', 'success');
    merged.active = boolOf_(merged.active);
    return { sku: merged };
  });
}

function handleDeleteSku_(user, payload, ctx) {
  require_(user.role, 'inventory_write');
  return withLock_(function () {
    var sku = skuByCode_(payload.itemCode);
    if (!sku) throw new ApiError('NOT_FOUND', 'Item not found.');
    if (sku.trackingType === 'quantity' && Number(sku.quantityOnHand || 0) > 0) {
      throw new ApiError('BLOCKED', 'Cannot delete: stock on hand.');
    }
    var openUnits = unitsOf_(sku.itemCode).filter(function (u) { return TERMINAL_STATUSES.indexOf(u.status) === -1; });
    if (sku.trackingType === 'serialized' && openUnits.length) {
      throw new ApiError('BLOCKED', 'Cannot delete: active units exist.');
    }
    var merged = {};
    SHEETS.Inventory.forEach(function (h) { merged[h] = sku[h]; });
    merged.active = false;
    updateRow_('Inventory', sku._row, merged);
    audit_(ctx, user.email, user.role, 'ITEM_DELETE', 'sku', sku.itemCode, 'Soft-deleted SKU', 'success');
    return { ok: true };
  });
}

function handleAddUnits_(user, payload, ctx) {
  require_(user.role, 'inventory_write');
  return withLock_(function () { return _addUnits_(user, payload, ctx); });
}

function _addUnits_(user, payload, ctx) {
  var sku = skuByCode_(payload.itemCode);
  if (!sku) throw new ApiError('NOT_FOUND', 'Item not found.');
  if (sku.trackingType !== 'serialized') throw new ApiError('VALIDATION', 'This item is quantity-tracked; use restock.');
  var existing = unitsOf_(sku.itemCode).length;
  var specs = payload.units || [];
  if (!specs.length) throw new ApiError('VALIDATION', 'Provide at least one unit.');
  var created = [];
  specs.forEach(function (spec, i) {
    var cond = spec.condition || 'Good';
    var loc = spec.location;
    if (CONDITIONS.indexOf(cond) === -1) throw new ApiError('VALIDATION', 'Unknown condition.');
    if (!loc || !_validLocation_(loc)) throw new ApiError('VALIDATION', 'Each unit needs a known location.');
    var uid = sku.itemCode + '-U' + ('00' + (existing + i + 1)).slice(-2);
    var rec = {
      unitId: uid, itemCode: sku.itemCode, serialNumber: (spec.serialNumber || '').trim(),
      condition: cond, status: 'Available', location: loc, currentHolder: '',
      photoFileId: spec.photoFileId || '', createdAt: nowIso_()
    };
    appendRow_('Units', rec);
    created.push(rec);
  });
  audit_(ctx, user.email, user.role, 'ITEM_EDIT', 'sku', sku.itemCode, 'Added ' + created.length + ' unit(s)', 'success');
  return { units: created };
}

function handleUpdateUnit_(user, payload, ctx) {
  require_(user.role, 'inventory_write');
  return withLock_(function () {
    var u = findRow_('Units', function (r) { return r.unitId === payload.unitId; });
    if (!u) throw new ApiError('NOT_FOUND', 'Unit not found.');
    var patch = payload.patch || {};
    var merged = {};
    SHEETS.Units.forEach(function (h) { merged[h] = u[h]; });
    if (patch.hasOwnProperty('condition')) {
      if (CONDITIONS.indexOf(patch.condition) === -1) throw new ApiError('VALIDATION', 'Unknown condition.');
      merged.condition = patch.condition;
    }
    if (patch.hasOwnProperty('location')) {
      if (!_validLocation_(patch.location)) throw new ApiError('VALIDATION', 'Unknown location.');
      merged.location = patch.location;
    }
    if (patch.hasOwnProperty('serialNumber')) merged.serialNumber = (patch.serialNumber || '').trim();
    if (patch.hasOwnProperty('photoFileId')) merged.photoFileId = patch.photoFileId || '';
    updateRow_('Units', u._row, merged);
    audit_(ctx, user.email, user.role, 'ITEM_EDIT', 'unit', u.unitId, 'Edited unit', 'success');
    return { unit: merged };
  });
}

// ===== Transactions ==========================================================

/** Receive / Issue / Borrow / Return / inspection + transaction reads. */

function _transactions_() { return readAll_('Transactions'); }

function _txn_(o) {
  var base = {
    txnId: uuid_(), slipNo: '', timestamp: nowIso_(), txnDate: todayStr_(), type: '',
    itemCode: '', unitId: '', qty: 0, qtyDamaged: 0, fromLocation: '', toLocation: '',
    party: '', employeeId: '', department: '', project: '', purpose: '', destination: '',
    expectedReturnDate: '', actualReturnDate: '', condition: '', requiresInspection: false,
    notes: '', processedBy: '', linkedTxnId: ''
  };
  Object.keys(o).forEach(function (k) { base[k] = o[k]; });
  return base;
}

function _unitByCode_(unitId) { return findRow_('Units', function (r) { return r.unitId === unitId; }); }

function _setUnit_(unit, patch) {
  var merged = {};
  SHEETS.Units.forEach(function (h) { merged[h] = unit[h]; });
  Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
  updateRow_('Units', unit._row, merged);
}
function _setSkuQty_(sku, qty) {
  var merged = {};
  SHEETS.Inventory.forEach(function (h) { merged[h] = sku[h]; });
  merged.quantityOnHand = qty;
  updateRow_('Inventory', sku._row, merged);
}

// ---- Receive ----
function handleReceive_(user, payload, ctx) {
  require_(user.role, 'receive');
  return withLock_(function () {
    var mode = payload.mode;
    var sku;
    if (mode === 'new') sku = _createSku_(user, payload, ctx).sku, sku = skuByCode_(sku.itemCode);
    else if (mode === 'restock') {
      sku = skuByCode_(payload.itemCode);
      if (!sku || !boolOf_(sku.active)) throw new ApiError('NOT_FOUND', 'Item not found.');
    } else throw new ApiError('VALIDATION', "mode must be 'new' or 'restock'.");

    var qty, toLoc = payload.location;
    if (sku.trackingType === 'serialized') {
      var added = _addUnits_(user, { itemCode: sku.itemCode, units: payload.units || [] }, ctx).units;
      qty = added.length;
      toLoc = added[0].location;
    } else {
      qty = parseInt(payload.qty, 10) || 0;
      if (qty <= 0) throw new ApiError('VALIDATION', 'Quantity must be positive.');
      if (toLoc && !_validLocation_(toLoc)) throw new ApiError('VALIDATION', 'Unknown location.');
      _setSkuQty_(sku, Number(sku.quantityOnHand || 0) + qty);
    }
    var txn = _txn_({
      type: 'RECEIVE', itemCode: sku.itemCode, qty: qty, txnDate: payload.txnDate || todayStr_(),
      toLocation: toLoc || '', purpose: payload.purpose || 'Received', notes: payload.notes || '', processedBy: user.email
    });
    appendRow_('Transactions', txn);
    audit_(ctx, user.email, user.role, 'RECEIVE', 'sku', sku.itemCode, 'Received ' + qty + ' (' + mode + ')', 'success');
    return { txn: txn, sku: skuByCode_(sku.itemCode) };
  });
}

// ---- shared target resolution ----
function _resolveTarget_(payload) {
  var sku = skuByCode_(payload.itemCode);
  if (!sku || !boolOf_(sku.active)) throw new ApiError('NOT_FOUND', 'Item not found.');
  var unit = null;
  if (sku.trackingType === 'serialized') {
    unit = _unitByCode_(payload.unitId);
    if (!unit) throw new ApiError('VALIDATION', 'Select a specific unit.');
  }
  return { sku: sku, unit: unit };
}

// ---- Issue ----
// Issue is always a PERMANENT departure (sold / consumed / handed off for good) —
// there is no return date and no return flow. Anything expected back is a Borrow
// (see handleBorrow_), which already has full loan + overdue + return support.
function handleIssue_(user, payload, ctx) {
  require_(user.role, 'issue');
  return withLock_(function () {
    var t = _resolveTarget_(payload);
    var recipient = String(payload.recipient || '').trim();
    var department = String(payload.department || '').trim();
    var purpose = String(payload.purpose || '').trim();
    if (!recipient || !department || !purpose) throw new ApiError('VALIDATION', 'Recipient, department and purpose are required.');
    var slip = 'ISS-' + ('000000' + nextCounter_('ISS')).slice(-6);
    var notes = String(payload.notes || '').trim();
    var qty, unitCondition = '';
    if (t.unit) {
      if (t.unit.status !== 'Available') throw new ApiError('BLOCKED', 'Unit is ' + t.unit.status + ', not Available.');
      qty = 1;
      unitCondition = t.unit.condition;
      // The unit leaves the database for good; the ISSUE transaction (with the
      // serial number folded into its notes) is the only record from here on.
      var sn = t.unit.serialNumber;
      var trace = sn ? 'S/N ' + sn : 'no serial';
      notes = trace + '; condition ' + t.unit.condition + ' at issue' + (notes ? '. ' + notes : '');
      sheet_('Units').deleteRow(t.unit._row);
    } else {
      qty = parseInt(payload.qty, 10) || 0;
      if (qty <= 0) throw new ApiError('VALIDATION', 'Quantity must be positive.');
      if (qty > Number(t.sku.quantityOnHand || 0)) throw new ApiError('BLOCKED', 'Not enough stock on hand.');
      _setSkuQty_(t.sku, Number(t.sku.quantityOnHand) - qty);
    }
    var txn = _txn_({
      type: 'ISSUE', itemCode: t.sku.itemCode, unitId: t.unit ? t.unit.unitId : '', qty: qty, slipNo: slip,
      txnDate: payload.txnDate || todayStr_(), party: recipient, department: department,
      destination: payload.destination || '', purpose: purpose,
      notes: notes, condition: unitCondition, processedBy: user.email
    });
    appendRow_('Transactions', txn);
    audit_(ctx, user.email, user.role, 'ISSUE', 'sku', t.sku.itemCode,
      'Issued ' + qty + ' to ' + recipient + ' (' + slip + ')', 'success');
    return { txn: txn };
  });
}

// ---- Borrow ----
function handleBorrow_(user, payload, ctx) {
  var onBehalf = !!payload.onBehalf;
  require_(user.role, onBehalf ? 'borrow_behalf' : 'borrow_self');
  return withLock_(function () {
    var t = _resolveTarget_(payload);
    var borrower = String(payload.borrowerName || '').trim();
    var emp = String(payload.employeeId || '').trim();
    var department = String(payload.department || '').trim();
    var purpose = String(payload.purpose || '').trim();
    var exp = payload.expectedReturnDate || '';
    if (!borrower || !emp || !department || !purpose || !exp) {
      throw new ApiError('VALIDATION', 'Borrower, employee ID, department, purpose and expected return date are required.');
    }
    var slip = 'BRW-' + ('000000' + nextCounter_('BRW')).slice(-6);
    var qty;
    if (t.unit) {
      if (t.unit.status !== 'Available') throw new ApiError('BLOCKED', 'Unit is ' + t.unit.status + ', not Available.');
      _setUnit_(t.unit, { status: 'Borrowed', currentHolder: borrower });
      qty = 1;
    } else {
      qty = parseInt(payload.qty, 10) || 0;
      if (qty <= 0) throw new ApiError('VALIDATION', 'Quantity must be positive.');
      if (qty > Number(t.sku.quantityOnHand || 0)) throw new ApiError('BLOCKED', 'Not enough stock on hand.');
      _setSkuQty_(t.sku, Number(t.sku.quantityOnHand) - qty);
    }
    var txn = _txn_({
      type: 'BORROW', itemCode: t.sku.itemCode, unitId: t.unit ? t.unit.unitId : '', qty: qty, slipNo: slip,
      txnDate: payload.borrowDate || todayStr_(), party: borrower, employeeId: emp, department: department,
      project: payload.project || '', purpose: purpose, expectedReturnDate: exp, processedBy: user.email
    });
    appendRow_('Transactions', txn);
    audit_(ctx, user.email, user.role, 'BORROW', 'sku', t.sku.itemCode, 'Borrowed ' + qty + ' to ' + borrower + ' (' + slip + '), due ' + exp, 'success');
    return { txn: txn };
  });
}

function _outstandingQty_(borrowTxn, allTxns) {
  var returned = 0;
  allTxns.forEach(function (t) {
    if (t.type === 'RETURN' && t.linkedTxnId === borrowTxn.txnId) {
      returned += Number(t.qty || 0) + Number(t.qtyDamaged || 0);
    }
  });
  return Number(borrowTxn.qty || 0) - returned;
}

// ---- Return ----
function handleReturn_(user, payload, ctx) {
  require_(user.role, 'return');
  return withLock_(function () {
    var all = _transactions_();
    var btxn = null;
    for (var i = 0; i < all.length; i++) if (all[i].txnId === payload.borrowTxnId && all[i].type === 'BORROW') { btxn = all[i]; break; }
    if (!btxn) throw new ApiError('NOT_FOUND', 'Borrow transaction not found.');
    var outstanding = _outstandingQty_(btxn, all);
    if (outstanding <= 0) throw new ApiError('BLOCKED', 'This borrow is already fully returned.');

    var condition = payload.condition || 'Good';
    if (CONDITIONS.indexOf(condition) === -1) throw new ApiError('VALIDATION', 'Unknown condition.');
    var requiresInspection = !!payload.requiresInspection || condition !== 'Good';
    var returnedBy = String(payload.returnedBy || '').trim() || btxn.party;
    var sku = skuByCode_(btxn.itemCode);
    var qtyGood, qtyDamaged;

    if (btxn.unitId) {
      var unit = _unitByCode_(btxn.unitId);
      qtyGood = condition !== 'Good' ? 0 : 1;
      qtyDamaged = condition !== 'Good' ? 1 : 0;
      if (unit) _setUnit_(unit, { currentHolder: '', condition: condition, status: requiresInspection ? 'Under inspection' : 'Available' });
    } else {
      qtyGood = parseInt(payload.qtyGood, 10) || 0;
      qtyDamaged = parseInt(payload.qtyDamaged, 10) || 0;
      if (qtyGood + qtyDamaged <= 0) throw new ApiError('VALIDATION', 'Enter a returned quantity.');
      if (qtyGood + qtyDamaged > outstanding) throw new ApiError('BLOCKED', 'Cannot return more than outstanding (' + outstanding + ').');
      _setSkuQty_(sku, Number(sku.quantityOnHand || 0) + qtyGood);
    }

    var txn = _txn_({
      type: 'RETURN', itemCode: btxn.itemCode, unitId: btxn.unitId || '', qty: qtyGood, qtyDamaged: qtyDamaged,
      txnDate: payload.returnDate || todayStr_(), actualReturnDate: payload.returnDate || todayStr_(),
      party: returnedBy, condition: condition, requiresInspection: requiresInspection,
      notes: payload.notes || '', processedBy: user.email, linkedTxnId: btxn.txnId
    });
    appendRow_('Transactions', txn);
    audit_(ctx, user.email, user.role, 'RETURN', 'sku', btxn.itemCode, 'Returned against ' + btxn.slipNo + ' (' + condition + ')', 'success');
    return { txn: txn };
  });
}

function handleClearInspection_(user, payload, ctx) {
  require_(user.role, 'return');
  return withLock_(function () {
    var unit = _unitByCode_(payload.unitId);
    if (!unit) throw new ApiError('NOT_FOUND', 'Unit not found.');
    if (unit.status !== 'Under inspection') throw new ApiError('BLOCKED', 'Unit is not under inspection.');
    var outcome = payload.outcome;
    if (['Available', 'Maintenance', 'Retired'].indexOf(outcome) === -1) throw new ApiError('VALIDATION', 'Invalid outcome.');
    _setUnit_(unit, { status: outcome });
    var txn = _txn_({
      type: 'ADJUST', itemCode: unit.itemCode, unitId: unit.unitId, qty: 0, purpose: 'Inspection cleared',
      notes: payload.notes || '', condition: unit.condition, processedBy: user.email, toLocation: unit.location
    });
    appendRow_('Transactions', txn);
    audit_(ctx, user.email, user.role, 'ITEM_EDIT', 'unit', unit.unitId, 'Inspection cleared -> ' + outcome, 'success');
    return { unit: _unitByCode_(unit.unitId), txn: txn };
  });
}

// ---- reads ----
function _historyRows_(itemCode, unitId) {
  return _transactions_().filter(function (t) {
    if (itemCode && t.itemCode !== itemCode) return false;
    if (unitId && t.unitId !== unitId) return false;
    return true;
  }).sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); });
}

function handleItemHistory_(user, payload) {
  return { rows: _historyRows_(payload.itemCode || null, payload.unitId || null) };
}

function _isOverdue_(expDate, grace) {
  if (!expDate) return false;
  var d = new Date(String(expDate).slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + (grace || 0));
  var cutoff = Utilities.formatDate(d, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  return cutoff < todayStr_();
}

function _openBorrows_() {
  var all = _transactions_();
  var grace = Number(configMap_().overdueGraceDays || 0);
  var out = [];
  all.forEach(function (t) {
    if (t.type !== 'BORROW') return;
    var outstanding = _outstandingQty_(t, all);
    if (outstanding <= 0) return;
    out.push({
      txnId: t.txnId, slipNo: t.slipNo, itemCode: t.itemCode, unitId: t.unitId || null,
      borrower: t.party, employeeId: t.employeeId, department: t.department, project: t.project,
      purpose: t.purpose, borrowDate: t.txnDate, expectedReturnDate: t.expectedReturnDate,
      outstanding: outstanding, processedBy: t.processedBy, overdue: _isOverdue_(t.expectedReturnDate, grace)
    });
  });
  return out;
}

function handleListBorrowed_() {
  var names = {};
  _skus_().forEach(function (s) { names[s.itemCode] = s.name; });
  return { rows: _openBorrows_().map(function (r) { r.itemName = names[r.itemCode] || r.itemCode; return r; }) };
}


function handleListTransactions_(user, payload) {
  var f = payload.filters || {};
  var rows = _transactions_().sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
  if (f.type) rows = rows.filter(function (r) { return r.type === f.type; });
  if (f.itemCode) rows = rows.filter(function (r) { return r.itemCode === f.itemCode; });
  if (f.user) rows = rows.filter(function (r) { return r.processedBy === f.user; });
  if (f.dateFrom) rows = rows.filter(function (r) { return String(r.txnDate) >= f.dateFrom; });
  if (f.dateTo) rows = rows.filter(function (r) { return String(r.txnDate) <= f.dateTo; });
  if (f.search) {
    var q = String(f.search).toLowerCase();
    rows = rows.filter(function (r) {
      return ['slipNo', 'itemCode', 'unitId', 'party', 'department', 'project', 'destination', 'purpose', 'notes', 'processedBy']
        .some(function (k) { return String(r[k] || '').toLowerCase().indexOf(q) !== -1; });
    });
  }
  var limit = parseInt(payload.limit, 10) || 50;
  var cursor = parseInt(payload.cursor, 10) || 0;
  var page = rows.slice(cursor, cursor + limit);
  return { rows: page, nextCursor: cursor + limit < rows.length ? cursor + limit : null, total: rows.length };
}

// ===== Dashboard =============================================================

/** Dashboard aggregation (cached 90s in CacheService). */

function handleGetDashboard_(user) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('dashboard');
  if (hit) return JSON.parse(hit);
  var data = _computeDashboard_();
  try { cache.put('dashboard', JSON.stringify(data), 90); } catch (e) {}
  return data;
}

function _computeDashboard_() {
  var skus = _skus_().filter(function (s) { return s.active; });
  var units = _units_();
  var cfg = configMap_();
  var lowThreshold = Number(cfg.lowStockThreshold || 5);

  var activeUnits = units.filter(function (u) { return TERMINAL_STATUSES.indexOf(u.status) === -1; });
  var availUnits = units.filter(function (u) { return u.status === 'Available'; });
  var inspection = units.filter(function (u) { return u.status === 'Under inspection'; });

  var open = _openBorrows_();
  var borrowedQty = 0, overdue = [];
  open.forEach(function (b) { borrowedQty += b.outstanding; if (b.overdue) overdue.push(b); });

  var qtyTotal = 0, lowStock = [];
  skus.forEach(function (s) {
    if (s.trackingType === 'quantity') {
      qtyTotal += Number(s.quantityOnHand || 0);
      if (Number(s.quantityOnHand || 0) <= lowThreshold) lowStock.push({ itemCode: s.itemCode, name: s.name, quantityOnHand: Number(s.quantityOnHand || 0) });
    }
  });

  // charts
  var byCat = {};
  skus.forEach(function (s) {
    var n = s.trackingType === 'serialized' ? unitsOf_(s.itemCode).length : Number(s.quantityOnHand || 0);
    byCat[s.category] = (byCat[s.category] || 0) + n;
  });
  var statusBreak = {};
  units.forEach(function (u) { statusBreak[u.status] = (statusBreak[u.status] || 0) + 1; });
  if (qtyTotal) statusBreak['Available'] = (statusBreak['Available'] || 0) + qtyTotal;

  // Zero-fill every day in the window so the chart is a real 30-day timeline,
  // not just the handful of days that happen to have a transaction.
  var activity = {};
  var tz = ss_().getSpreadsheetTimeZone();
  var start = new Date(); start.setDate(start.getDate() - 29);
  for (var i = 0; i < 30; i++) {
    var dd = new Date(start); dd.setDate(start.getDate() + i);
    var key = Utilities.formatDate(dd, tz, 'yyyy-MM-dd');
    activity[key] = { date: key, RECEIVE: 0, ISSUE: 0, BORROW: 0, RETURN: 0 };
  }
  _transactions_().forEach(function (t) {
    var d = String(t.txnDate).slice(0, 10);
    if (activity[d] && activity[d].hasOwnProperty(t.type)) activity[d][t.type]++;
  });

  var recent = _transactions_().sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); }).slice(0, 10);

  return {
    tiles: {
      skus: skus.length,
      totalStock: activeUnits.length + qtyTotal,
      available: availUnits.length + qtyTotal,
      borrowed: borrowedQty,
      overdue: overdue.length,
      lowStock: lowStock.length,
      underInspection: inspection.length
    },
    recent: recent,
    charts: {
      byCategory: Object.keys(byCat).sort().map(function (k) { return { label: k, value: byCat[k] }; }),
      statusBreakdown: Object.keys(statusBreak).sort().map(function (k) { return { label: k, value: statusBreak[k] }; }),
      activity30d: Object.keys(activity).sort().map(function (k) { return activity[k]; })
    },
    lowStockItems: lowStock,
    overdueItems: overdue
  };
}

// ===== Reports ===============================================================

/** Server-side data for exports (client renders CSV/XLSX). */

function handleExportData_(user, payload, ctx) {
  var report = payload.report;
  var defs = ['inventory', 'incoming', 'outgoing', 'borrowed', 'overdue', 'transactions', 'audit'];
  if (defs.indexOf(report) === -1) throw new ApiError('VALIDATION', 'Unknown report.');
  require_(user.role, 'export');
  if (report === 'audit') require_(user.role, 'export_audit');
  var f = payload.filters || {};
  var columns, rows;

  if (report === 'inventory') {
    columns = ['itemCode', 'name', 'category', 'brand', 'model', 'trackingType', 'quantityOnHand', 'unitsCount', 'active'];
    rows = _skus_().map(function (s) {
      return {
        itemCode: s.itemCode, name: s.name, category: s.category, brand: s.brand, model: s.model,
        trackingType: s.trackingType, quantityOnHand: s.quantityOnHand,
        unitsCount: unitsOf_(s.itemCode).length, active: s.active
      };
    });
  } else if (report === 'incoming' || report === 'outgoing' || report === 'transactions') {
    var types = report === 'incoming' ? ['RECEIVE'] : report === 'outgoing' ? ['ISSUE', 'BORROW'] : null;
    columns = ['txnId', 'slipNo', 'txnDate', 'type', 'itemCode', 'unitId', 'qty', 'qtyDamaged', 'party', 'department', 'purpose', 'expectedReturnDate', 'condition', 'processedBy', 'notes'];
    rows = _transactions_()
      .filter(function (t) { return !types || types.indexOf(t.type) !== -1; })
      .filter(function (t) { return !f.dateFrom || String(t.txnDate) >= f.dateFrom; })
      .filter(function (t) { return !f.dateTo || String(t.txnDate) <= f.dateTo; })
      .sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); })
      .map(function (t) { var o = {}; columns.forEach(function (c) { o[c] = t[c]; }); return o; });
  } else if (report === 'borrowed') {
    columns = ['slipNo', 'itemCode', 'unitId', 'borrower', 'employeeId', 'department', 'project', 'purpose', 'borrowDate', 'expectedReturnDate', 'outstanding', 'overdue'];
    rows = _openBorrows_().map(function (b) { var o = {}; columns.forEach(function (c) { o[c] = b[c]; }); return o; });
  } else if (report === 'overdue') {
    columns = ['slipNo', 'itemCode', 'unitId', 'borrower', 'department', 'borrowDate', 'expectedReturnDate', 'outstanding'];
    rows = _openBorrows_().filter(function (b) { return b.overdue; }).map(function (b) { var o = {}; columns.forEach(function (c) { o[c] = b[c]; }); return o; });
  } else if (report === 'audit') {
    if (!f.dateFrom || !f.dateTo) throw new ApiError('VALIDATION', 'Audit export requires a date range.');
    columns = ['auditId', 'timestamp', 'userEmail', 'role', 'action', 'targetType', 'targetId', 'summary', 'result'];
    rows = readAll_('AuditLog')
      .filter(function (r) { var d = String(r.timestamp).slice(0, 10); return d >= f.dateFrom && d <= f.dateTo; })
      .map(function (r) { var o = {}; columns.forEach(function (c) { o[c] = r[c]; }); return o; });
  }

  if (rows.length > EXPORT_CAP) throw new ApiError('BLOCKED', 'Export exceeds ' + EXPORT_CAP + ' rows; narrow the date range.');
  audit_(ctx, user.email, user.role, 'EXPORT', 'report', report, 'Exported ' + report + ' (' + rows.length + ' rows)', 'success');
  return { columns: columns, rows: rows };
}

// ===== AuditAndImages ========================================================

/** Audit log reads + Drive image upload. */

function handleListAudit_(user, payload) {
  require_(user.role, 'audit');
  var f = payload.filters || {};
  if (!f.dateFrom || !f.dateTo) throw new ApiError('VALIDATION', 'Audit log requires a date range.');
  var rows = readAll_('AuditLog')
    .filter(function (r) { var d = String(r.timestamp).slice(0, 10); return d >= f.dateFrom && d <= f.dateTo; })
    .sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
  if (f.user) rows = rows.filter(function (r) { return String(r.userEmail).indexOf(f.user) !== -1; });
  if (f.action) rows = rows.filter(function (r) { return r.action === f.action; });
  var limit = parseInt(payload.limit, 10) || 100;
  var cursor = parseInt(payload.cursor, 10) || 0;
  var page = rows.slice(cursor, cursor + limit).map(function (r) {
    return {
      auditId: r.auditId, timestamp: r.timestamp, userEmail: r.userEmail, role: r.role,
      action: r.action, targetType: r.targetType, targetId: r.targetId, summary: r.summary, result: r.result
    };
  });
  return { rows: page, nextCursor: cursor + limit < rows.length ? cursor + limit : null, total: rows.length };
}

// Product-photo folder, found by name (created on first use). Keep the name unique
// in your Drive — if two folders share it, the first one wins.
function photoFolder_() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function handleUploadImage_(user, payload, ctx) {
  require_(user.role, 'inventory_write');
  var data = payload.dataBase64 || '';
  if (!data) throw new ApiError('VALIDATION', 'No image data.');
  var mime = payload.mime || 'image/jpeg';
  var folder = photoFolder_();
  var bytes = Utilities.base64Decode(data);
  var ext = mime.indexOf('png') !== -1 ? 'png' : 'jpg';
  var blob = Utilities.newBlob(bytes, mime, 'wms_' + Date.now() + '.' + ext);
  var file = folder.createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { fileId: file.getId(), url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400' };
}

/** Time-driven trigger: delete Drive images no longer referenced by any sheet row. */
function sweepOrphanImages() {
  var referenced = {};
  readAll_('Inventory').forEach(function (s) { if (s.photoFileId) referenced[s.photoFileId] = 1; });
  readAll_('Units').forEach(function (u) { if (u.photoFileId) referenced[u.photoFileId] = 1; });
  var folder = photoFolder_();
  var files = folder.getFiles();
  var cutoff = Date.now() - 24 * 3600 * 1000; // keep very recent uploads (may not be saved yet)
  while (files.hasNext()) {
    var f = files.next();
    if (!referenced[f.getId()] && f.getDateCreated().getTime() < cutoff) {
      f.setTrashed(true);
    }
  }
}

// ===== Setup =================================================================

/**
 * One-time setup (run from the Apps Script editor). Creates the tabs, seeds
 * default config, generates the password secret, creates the one admin from the
 * BOOTSTRAP_ADMIN_* constants at the top of this file, and installs triggers.
 * No sample items, categories or locations. Safe to re-run.
 */

function setup() {
  var ss = ss_();

  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    var headers = SHEETS[name];
    var first = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (first.join('') !== headers.join('')) {
      sh.clear();
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
  });

  // seed config
  var cfg = configMap_();
  if (!cfg.lowStockThreshold) setConfig_('lowStockThreshold', 5);
  if (!cfg.overdueGraceDays) setConfig_('overdueGraceDays', 0);
  setConfig_('schemaVersion', SCHEMA_VERSION);
  if (!cfg.pepper) { setConfig_('pepper', randomToken_()); _pepperCache = null; }

  // Categories and Locations start empty — add your own on the Settings page
  // before receiving stock.

  // bootstrap admin
  var email = String(BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase();
  if (email && !userByEmail_(email)) {
    appendRow_('Users', {
      email: email, name: 'Admin', role: 'Admin', active: true,
      passwordHash: hashPassword_(BOOTSTRAP_ADMIN_PASSWORD), failedCount: 0, lockedUntil: '',
      createdAt: nowIso_(), createdBy: 'setup'
    });
    Logger.log('Created admin ' + email + ' — sign in and change the password now.');
  }

  installTriggers_();
  Logger.log('Setup complete. Schema v' + SCHEMA_VERSION);
}

/**
 * Editor helper. Re-hashes the admin (BOOTSTRAP_ADMIN_EMAIL) password to
 * BOOTSTRAP_ADMIN_PASSWORD, clears any lockout, reactivates. Run this if you're
 * locked out, or after changing HASH_ITERATIONS (old hashes keep their old,
 * slower count until re-hashed).
 */
function resetAdmin() {
  var email = String(BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase();
  var user = userByEmail_(email);
  if (!user) { setup(); return; }
  _patchUser_(user, {
    passwordHash: hashPassword_(BOOTSTRAP_ADMIN_PASSWORD),
    failedCount: 0, lockedUntil: '', active: true
  });
  Logger.log('Admin ' + email + ' reset to BOOTSTRAP_ADMIN_PASSWORD (' + HASH_ITERATIONS + ' iterations).');
}

function installTriggers_() {
  var existing = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (existing.indexOf('purgeSessions') === -1) {
    ScriptApp.newTrigger('purgeSessions').timeBased().everyHours(6).create();
  }
  if (existing.indexOf('sweepOrphanImages') === -1) {
    ScriptApp.newTrigger('sweepOrphanImages').timeBased().everyDays(1).create();
  }
}

/** Rebuild Units.status and Inventory.quantityOnHand by replaying the ledger. */
function recomputeFromLedger() {
  withLock_(function () {
    var txns = _transactions_().sort(function (a, b) { return String(a.timestamp).localeCompare(String(b.timestamp)); });
    var units = _units_();
    var unitMap = {};
    units.forEach(function (u) { unitMap[u.unitId] = u; u._status = 'Available'; u._holder = ''; });
    var qty = {};

    txns.forEach(function (t) {
      if (t.type === 'RECEIVE' && !t.unitId && t.itemCode) qty[t.itemCode] = (qty[t.itemCode] || 0) + Number(t.qty || 0);
      // Issue is always permanent: a serialized unit is deleted at issue time (so it
      // won't be in unitMap here), and quantity stock is simply deducted.
      if (t.type === 'ISSUE' && !t.unitId) qty[t.itemCode] = (qty[t.itemCode] || 0) - Number(t.qty || 0);
      if (t.type === 'BORROW') {
        if (t.unitId && unitMap[t.unitId]) { unitMap[t.unitId]._status = 'Borrowed'; unitMap[t.unitId]._holder = t.party; }
        else qty[t.itemCode] = (qty[t.itemCode] || 0) - Number(t.qty || 0);
      }
      if (t.type === 'RETURN') {
        if (t.unitId && unitMap[t.unitId]) {
          unitMap[t.unitId]._status = t.requiresInspection || t.condition !== 'Good' ? 'Under inspection' : 'Available';
          unitMap[t.unitId]._holder = '';
        } else qty[t.itemCode] = (qty[t.itemCode] || 0) + Number(t.qty || 0);
      }
      if (t.type === 'ADJUST' && t.unitId && unitMap[t.unitId] && t.purpose === 'Inspection cleared') {
        // leave as-is; ADJUST outcome not stored in ledger detail — keep current sheet status
      }
    });

    units.forEach(function (u) {
      if (['Retired', 'Lost', 'Maintenance'].indexOf(u.status) !== -1) return; // don't override manually-set terminal states
      _setUnit_(u, { status: u._status, currentHolder: u._holder });
    });
    _skus_().forEach(function (s) {
      if (s.trackingType === 'quantity') _setSkuQty_(s, Math.max(0, qty[s.itemCode] || 0));
    });
    Logger.log('Recompute complete.');
  });
}

// ===== Main ==================================================================

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

// ===== Tests =================================================================

/**
 * Hand-rolled test suite. Creates a throwaway spreadsheet, runs against it, and
 * trashes it — the bound sheet is never touched. Run runAllTests() from the
 * editor and read the log.
 */

var _T = { pass: 0, fail: 0, log: [] };

function _assert(cond, msg) {
  if (cond) { _T.pass++; _T.log.push('  ok   ' + msg); }
  else { _T.fail++; _T.log.push(' FAIL  ' + msg); }
}
function _throws(fn, code, msg) {
  try { fn(); _assert(false, msg + ' (expected throw)'); }
  catch (e) { _assert(!code || e.code === code, msg + ' (' + (e.code || e) + ')'); }
}

function runAllTests() {
  _T = { pass: 0, fail: 0, log: [] };
  var realCache = _ssCache, realPepper = _pepperCache;
  var tmp = SpreadsheetApp.create('WMS test — ' + new Date().toISOString());
  _ssCache = tmp;
  _pepperCache = 'test-pepper';
  try {
    _wipeAndSetup();
    test_crypto();
    test_authAndSession();
    test_rbac();
    test_inventoryAndSerializedFlow();
    test_quantityFlow();
    test_permanentIssueRemovesUnit();
    test_overReturnRejected();
    test_vocabEditing();
    test_recompute();
  } finally {
    _ssCache = realCache;
    _pepperCache = realPepper;
    try { DriveApp.getFileById(tmp.getId()).setTrashed(true); } catch (e) {}
  }
  _T.log.push('');
  _T.log.push(_T.fail ? (_T.fail + ' FAILURES / ' + _T.pass + ' passed') : ('ALL ' + _T.pass + ' PASSED'));
  Logger.log(_T.log.join('\n'));
  return _T;
}

function _wipeAndSetup() {
  var ss = ss_();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clear();
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]);
  });
  setConfig_('lowStockThreshold', 5);
  setConfig_('overdueGraceDays', 0);
  setConfig_('schemaVersion', SCHEMA_VERSION);
  ['Power Tools', 'Consumables'].forEach(function (c) { appendRow_('Categories', { name: c }); });
  ['A-01', 'STAGING'].forEach(function (c) { appendRow_('Locations', { code: c }); });
  appendRow_('Users', {
    email: 'admin@test.local', name: 'Admin', role: 'Admin', active: true,
    passwordHash: hashPassword_('password1'), failedCount: 0, lockedUntil: '', createdAt: nowIso_(), createdBy: 'test'
  });
  appendRow_('Users', {
    email: 'view@test.local', name: 'Viewer', role: 'Viewer', active: true,
    passwordHash: hashPassword_('password1'), failedCount: 0, lockedUntil: '', createdAt: nowIso_(), createdBy: 'test'
  });
}

function _login(email, pw) {
  return handleLogin_({ email: email, password: pw }, { userAgent: 'test' });
}
function _user(email) { var u = userByEmail_(email); u._token = 'x'; return u; }

function test_crypto() {
  var h = hashPassword_('hunter2');
  _assert(verifyPassword_('hunter2', h), 'password verifies');
  _assert(!verifyPassword_('wrong', h), 'wrong password rejected');
  _assert(h.split(':').length === 3, 'hash format salt:iter:hex');
}

function test_authAndSession() {
  var r = _login('admin@test.local', 'password1');
  _assert(!!r.token, 'login returns token');
  _assert(r.user.role === 'Admin', 'login role Admin');
  var u = authenticate_(r.token, { userAgent: 't' });
  _assert(u.email === 'admin@test.local', 'authenticate resolves user');
  _throws(function () { _login('admin@test.local', 'nope'); }, 'AUTH_FAILED', 'bad password rejected');
  _throws(function () { authenticate_('badtoken', {}); }, 'AUTH_EXPIRED', 'bad token rejected');
}

function test_rbac() {
  _throws(function () { require_('Viewer', 'receive'); }, 'FORBIDDEN', 'viewer cannot receive');
  require_('Warehouse Staff', 'receive'); _assert(true, 'staff can receive');
  _throws(function () { require_('Warehouse Staff', 'users'); }, 'FORBIDDEN', 'staff cannot manage users');
}

function test_inventoryAndSerializedFlow() {
  var admin = _user('admin@test.local');
  var ctx = { userAgent: 't' };
  var res = handleReceive_(admin, {
    mode: 'new', name: 'Drill', category: 'Power Tools', trackingType: 'serialized',
    units: [{ condition: 'Good', location: 'A-01' }, { condition: 'Good', location: 'A-01' }], purpose: 'stock'
  }, ctx);
  var code = res.sku.itemCode;
  _assert(unitsOf_(code).length === 2, 'received 2 serialized units');

  var uid = unitsOf_(code)[0].unitId;
  handleBorrow_(admin, {
    itemCode: code, unitId: uid, borrowerName: 'Bob', employeeId: 'E1', department: 'Field',
    purpose: 'job', expectedReturnDate: '2099-01-01'
  }, ctx);
  _assert(_unitByCode_(uid).status === 'Borrowed', 'unit marked Borrowed');
  _throws(function () {
    handleBorrow_(admin, { itemCode: code, unitId: uid, borrowerName: 'X', employeeId: 'E2', department: 'D', purpose: 'p', expectedReturnDate: '2099-01-01' }, ctx);
  }, 'BLOCKED', 'cannot borrow already-borrowed unit');

  var btxn = _openBorrows_()[0].txnId;
  handleReturn_(admin, { borrowTxnId: btxn, returnDate: '2098-01-01', returnedBy: 'Bob', condition: 'Good', requiresInspection: false }, ctx);
  _assert(_unitByCode_(uid).status === 'Available', 'returned unit Available');
  _assert(_openBorrows_().length === 0, 'no open borrows after return');

  // damaged return -> inspection
  var uid2 = unitsOf_(code)[1].unitId;
  handleBorrow_(admin, { itemCode: code, unitId: uid2, borrowerName: 'Cy', employeeId: 'E3', department: 'D', purpose: 'p', expectedReturnDate: '2099-01-01' }, ctx);
  var b2 = _openBorrows_()[0].txnId;
  handleReturn_(admin, { borrowTxnId: b2, returnDate: '2098-01-01', returnedBy: 'Cy', condition: 'Damaged' }, ctx);
  _assert(_unitByCode_(uid2).status === 'Under inspection', 'damaged return -> Under inspection');
  handleClearInspection_(admin, { unitId: uid2, outcome: 'Available' }, ctx);
  _assert(_unitByCode_(uid2).status === 'Available', 'clearInspection -> Available');
}

function test_quantityFlow() {
  var admin = _user('admin@test.local');
  var ctx = { userAgent: 't' };
  var res = handleReceive_(admin, { mode: 'new', name: 'Gloves', category: 'Consumables', trackingType: 'quantity', qty: 10, location: 'STAGING', purpose: 'stock' }, ctx);
  var code = res.sku.itemCode;
  _assert(skuByCode_(code).quantityOnHand === 10, 'qty on hand 10');
  _throws(function () {
    handleIssue_(admin, { itemCode: code, qty: 99, recipient: 'R', department: 'D', purpose: 'p' }, ctx);
  }, 'BLOCKED', 'cannot issue more than on hand');
  handleIssue_(admin, { itemCode: code, qty: 4, recipient: 'R', department: 'D', purpose: 'p' }, ctx);
  _assert(skuByCode_(code).quantityOnHand === 6, 'qty on hand 6 after issue (issue is always permanent)');
}

function test_permanentIssueRemovesUnit() {
  var admin = _user('admin@test.local');
  var ctx = { userAgent: 't' };
  var res = handleReceive_(admin, {
    mode: 'new', name: 'Router', category: 'Power Tools', trackingType: 'serialized',
    units: [{ serialNumber: 'RTR-9', condition: 'Good', location: 'A-01' }], purpose: 'stock'
  }, ctx);
  var code = res.sku.itemCode;
  var soldUnitId = unitsOf_(code)[0].unitId;

  // issuing a serialized unit is always permanent -> unit row deleted, history keeps the record
  handleIssue_(admin, { itemCode: code, unitId: soldUnitId, recipient: 'Cust', department: 'Sales', purpose: 'sold' }, ctx);
  _assert(_unitByCode_(soldUnitId) === null, 'issuing a unit deletes its row');
  _assert(unitsOf_(code).length === 0, 'SKU now has 0 units');
  var hist = _historyRows_(code, null);
  var issueTxn = hist.filter(function (h) { return h.type === 'ISSUE' && h.unitId === soldUnitId; })[0];
  _assert(!!issueTxn, 'ISSUE transaction for the sold unit is retained in history');
  _assert(String(issueTxn.notes).indexOf('RTR-9') !== -1, 'serial number captured in the ISSUE transaction notes');
  _assert(!issueTxn.expectedReturnDate, 'issue has no expected-return concept');
}

function test_overReturnRejected() {
  var admin = _user('admin@test.local');
  var ctx = { userAgent: 't' };
  var res = handleReceive_(admin, { mode: 'new', name: 'Rags', category: 'Consumables', trackingType: 'quantity', qty: 5, location: 'STAGING', purpose: 's' }, ctx);
  var code = res.sku.itemCode;
  handleBorrow_(admin, { itemCode: code, qty: 3, borrowerName: 'B', employeeId: 'E', department: 'D', purpose: 'p', expectedReturnDate: '2099-01-01' }, ctx);
  var bt = _openBorrows_().filter(function (b) { return b.itemCode === code; })[0].txnId;
  _throws(function () {
    handleReturn_(admin, { borrowTxnId: bt, returnDate: '2098-01-01', returnedBy: 'B', condition: 'Good', qtyGood: 5, qtyDamaged: 0 }, ctx);
  }, 'BLOCKED', 'cannot return more than borrowed');
  handleReturn_(admin, { borrowTxnId: bt, returnDate: '2098-01-01', returnedBy: 'B', condition: 'Good', qtyGood: 3, qtyDamaged: 0 }, ctx);
  _assert(skuByCode_(code).quantityOnHand === 5, 'quantity restored after full return');
}

function test_vocabEditing() {
  var admin = _user('admin@test.local');
  var ctx = { userAgent: 't' };
  handleAddLocation_(admin, { code: 'dock-1' }, ctx);
  _assert(listCol_('Locations', 'code').indexOf('DOCK-1') !== -1, 'addLocation uppercases');
  handleRenameLocation_(admin, { old: 'DOCK-1', 'new': 'dock-2' }, ctx);
  _assert(listCol_('Locations', 'code').indexOf('DOCK-2') !== -1, 'renameLocation unused');
  handleDeleteLocation_(admin, { code: 'DOCK-2' }, ctx);
  _assert(listCol_('Locations', 'code').indexOf('DOCK-2') === -1, 'deleteLocation unused');

  _throws(function () { handleDeleteLocation_(admin, { code: 'A-01' }, ctx); }, 'BLOCKED', 'deleteLocation in-use blocked');
  handleRenameLocation_(admin, { old: 'A-01', 'new': 'AISLE-1' }, ctx);
  _assert(_units_().filter(function (u) { return u.location === 'A-01'; }).length === 0, 'rename cascaded units off A-01');

  _throws(function () { handleDeleteCategory_(admin, { name: 'Power Tools' }, ctx); }, 'BLOCKED', 'deleteCategory in-use blocked');
  handleRenameCategory_(admin, { old: 'Power Tools', 'new': 'Powered Tools' }, ctx);
  _assert(readAll_('Inventory').filter(function (s) { return s.category === 'Power Tools'; }).length === 0, 'rename cascaded SKUs');
  _throws(function () { require_('Warehouse Staff', 'config_write'); }, 'FORBIDDEN', 'staff cannot edit vocab');
}

function test_recompute() {
  recomputeFromLedger();
  _assert(true, 'recomputeFromLedger runs without error');
}


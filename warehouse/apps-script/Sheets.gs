/** Data-access layer over the Spreadsheet. Rows are plain objects keyed by SHEETS[name]. */

var _ssCache = null;
function ss_() {
  if (!_ssCache) _ssCache = SpreadsheetApp.openById(requireProp_('SPREADSHEET_ID'));
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

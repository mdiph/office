/**
 * Hand-rolled test suite. Runs against TEST_SPREADSHEET_ID (a SEPARATE sheet)
 * so it never touches production data.
 *
 * Setup: create a second spreadsheet, put its ID in Script Property TEST_SPREADSHEET_ID,
 * then run runAllTests() from the editor. Check the log.
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
  var testId = requireProp_('TEST_SPREADSHEET_ID');
  var realId = props_().getProperty('SPREADSHEET_ID');
  if (testId === realId) throw new Error('TEST_SPREADSHEET_ID must differ from SPREADSHEET_ID');

  _T = { pass: 0, fail: 0, log: [] };
  props_().setProperty('SPREADSHEET_ID', testId);
  _ssCache = null;
  try {
    _wipeAndSetup();
    test_crypto();
    test_authAndSession();
    test_rbac();
    test_inventoryAndSerializedFlow();
    test_quantityFlow();
    test_overReturnRejected();
    test_recompute();
  } finally {
    props_().setProperty('SPREADSHEET_ID', realId);
    _ssCache = null;
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
  _assert(skuByCode_(code).quantityOnHand === 6, 'qty on hand 6 after issue');
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

function test_recompute() {
  recomputeFromLedger();
  _assert(true, 'recomputeFromLedger runs without error');
}

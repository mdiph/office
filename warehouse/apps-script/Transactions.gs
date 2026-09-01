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
function handleIssue_(user, payload, ctx) {
  require_(user.role, 'issue');
  return withLock_(function () {
    var t = _resolveTarget_(payload);
    var recipient = String(payload.recipient || '').trim();
    var department = String(payload.department || '').trim();
    var purpose = String(payload.purpose || '').trim();
    if (!recipient || !department || !purpose) throw new ApiError('VALIDATION', 'Recipient, department and purpose are required.');
    var exp = payload.expectedReturnDate || '';
    var slip = 'ISS-' + ('000000' + nextCounter_('ISS')).slice(-6);
    var qty;
    if (t.unit) {
      if (t.unit.status !== 'Available') throw new ApiError('BLOCKED', 'Unit is ' + t.unit.status + ', not Available.');
      _setUnit_(t.unit, { status: 'Issued-out', currentHolder: recipient });
      qty = 1;
    } else {
      qty = parseInt(payload.qty, 10) || 0;
      if (qty <= 0) throw new ApiError('VALIDATION', 'Quantity must be positive.');
      if (qty > Number(t.sku.quantityOnHand || 0)) throw new ApiError('BLOCKED', 'Not enough stock on hand.');
      _setSkuQty_(t.sku, Number(t.sku.quantityOnHand) - qty);
    }
    var txn = _txn_({
      type: 'ISSUE', itemCode: t.sku.itemCode, unitId: t.unit ? t.unit.unitId : '', qty: qty, slipNo: slip,
      txnDate: payload.txnDate || todayStr_(), party: recipient, department: department,
      destination: payload.destination || '', purpose: purpose, expectedReturnDate: exp, processedBy: user.email
    });
    appendRow_('Transactions', txn);
    audit_(ctx, user.email, user.role, 'ISSUE', 'sku', t.sku.itemCode, 'Issued ' + qty + ' to ' + recipient + ' (' + slip + ')', 'success');
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

function _returnableIssues_() {
  var all = _transactions_();
  return all.filter(function (t) {
    if (t.type !== 'ISSUE' || !t.expectedReturnDate) return false;
    return !all.some(function (x) { return x.type === 'RETURN' && x.linkedTxnId === t.txnId; });
  });
}

function handleListTransactions_(user, payload) {
  var f = payload.filters || {};
  var rows = _transactions_().sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
  if (f.type) rows = rows.filter(function (r) { return r.type === f.type; });
  if (f.itemCode) rows = rows.filter(function (r) { return r.itemCode === f.itemCode; });
  if (f.user) rows = rows.filter(function (r) { return r.processedBy === f.user; });
  if (f.dateFrom) rows = rows.filter(function (r) { return String(r.txnDate) >= f.dateFrom; });
  if (f.dateTo) rows = rows.filter(function (r) { return String(r.txnDate) <= f.dateTo; });
  var limit = parseInt(payload.limit, 10) || 50;
  var cursor = parseInt(payload.cursor, 10) || 0;
  var page = rows.slice(cursor, cursor + limit);
  return { rows: page, nextCursor: cursor + limit < rows.length ? cursor + limit : null, total: rows.length };
}

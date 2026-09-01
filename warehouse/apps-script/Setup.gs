/**
 * One-time setup. From the Apps Script editor:
 *   1. Set Script Properties (see Config.gs header).
 *   2. Run setup()  — creates tabs, seeds config/vocab, creates bootstrap admin, installs triggers.
 *   3. Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 *   4. Paste the /exec URL into warehouse/config.js and flip API_MODE to "prod".
 *
 * seedDemoData() adds sample inventory — NEVER run in production.
 */

function setup() {
  var ss = SpreadsheetApp.openById(requireProp_('SPREADSHEET_ID'));

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

  // seed vocab
  if (readAll_('Categories').length === 0) {
    ['Power Tools', 'Hand Tools', 'Test Equipment', 'Safety Gear', 'Consumables', 'IT Equipment']
      .forEach(function (c) { appendRow_('Categories', { name: c }); });
  }
  if (readAll_('Locations').length === 0) {
    ['A-01', 'A-02', 'B-01', 'B-02', 'STAGING', 'QUARANTINE']
      .forEach(function (c) { appendRow_('Locations', { code: c }); });
  }

  // bootstrap admin
  var email = prop_('BOOTSTRAP_ADMIN_EMAIL', '');
  var pw = prop_('BOOTSTRAP_ADMIN_PASSWORD', '');
  if (email && pw && !userByEmail_(email)) {
    appendRow_('Users', {
      email: String(email).toLowerCase(), name: 'Bootstrap Admin', role: 'Admin', active: true,
      passwordHash: hashPassword_(pw), failedCount: 0, lockedUntil: '', createdAt: nowIso_(), createdBy: 'setup'
    });
    props_().deleteProperty('BOOTSTRAP_ADMIN_PASSWORD');
    Logger.log('Created bootstrap admin: ' + email + ' (password property deleted)');
  }

  installTriggers_();
  Logger.log('Setup complete. Schema v' + SCHEMA_VERSION);
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
      if (t.type === 'ISSUE') {
        if (t.unitId && unitMap[t.unitId]) {
          unitMap[t.unitId]._status = t.expectedReturnDate ? 'Issued-out' : 'Released';
          unitMap[t.unitId]._holder = t.party;
        } else qty[t.itemCode] = (qty[t.itemCode] || 0) - Number(t.qty || 0);
      }
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

function seedDemoData() {
  var admin = readAll_('Users')[0];
  var by = admin ? admin.email : 'setup';
  var ctx = { userAgent: 'seed' };
  var fakeUser = { email: by, role: 'Admin' };
  withLock_(function () {
    _createSku_(fakeUser, { name: 'Cordless Drill 18V', category: 'Power Tools', trackingType: 'serialized', brand: 'DeWalt', model: 'DCD777' }, ctx);
    _createSku_(fakeUser, { name: 'Digital Multimeter', category: 'Test Equipment', trackingType: 'serialized', brand: 'Fluke', model: '117' }, ctx);
    _createSku_(fakeUser, { name: 'Nitrile Gloves (Box of 100)', category: 'Consumables', trackingType: 'quantity', brand: 'Ansell' }, ctx);
  });
  Logger.log('Demo SKUs created. Use Receive in the app to add stock/units.');
}

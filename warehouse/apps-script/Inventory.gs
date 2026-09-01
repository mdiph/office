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
    var openUnits = unitsOf_(sku.itemCode).filter(function (u) { return ['Retired', 'Lost'].indexOf(u.status) === -1; });
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

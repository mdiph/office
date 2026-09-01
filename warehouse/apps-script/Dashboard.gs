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

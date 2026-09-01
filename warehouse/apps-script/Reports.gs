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

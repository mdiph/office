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

function handleUploadImage_(user, payload, ctx) {
  require_(user.role, 'inventory_write');
  var data = payload.dataBase64 || '';
  if (!data) throw new ApiError('VALIDATION', 'No image data.');
  var mime = payload.mime || 'image/jpeg';
  var folder = DriveApp.getFolderById(requireProp_('DRIVE_FOLDER_ID'));
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
  var folder = DriveApp.getFolderById(requireProp_('DRIVE_FOLDER_ID'));
  var files = folder.getFiles();
  var cutoff = Date.now() - 24 * 3600 * 1000; // keep very recent uploads (may not be saved yet)
  while (files.hasNext()) {
    var f = files.next();
    if (!referenced[f.getId()] && f.getDateCreated().getTime() < cutoff) {
      f.setTrashed(true);
    }
  }
}

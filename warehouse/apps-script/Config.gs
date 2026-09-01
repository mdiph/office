/**
 * Warehouse Management — Apps Script backend.
 * Constants and Script-Property accessors.
 *
 * Set these Script Properties (Project Settings → Script properties) before running setup():
 *   SPREADSHEET_ID       - the Google Sheet that holds all tabs
 *   DRIVE_FOLDER_ID      - Drive folder for product photos
 *   PASSWORD_PEPPER      - long random string, mixed into every password hash (keep secret)
 *   BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD - first admin (cleared by setup())
 * Optional:
 *   HASH_ITERATIONS      - default 50000
 *   TEST_SPREADSHEET_ID  - separate sheet used by Tests.gs
 */

var SCHEMA_VERSION = 1;

var SESSION_IDLE_MS = 8 * 60 * 60 * 1000;    // 8h sliding idle
var SESSION_ABS_MS  = 24 * 60 * 60 * 1000;   // 24h absolute
var MAX_FAILED_LOGINS = 5;
var LOCK_MINUTES = 15;
var EXPORT_CAP = 50000;
var LOCK_TIMEOUT_MS = 25000;

var STATUSES = ['Available', 'Borrowed', 'Issued-out', 'Under inspection', 'Maintenance', 'Retired', 'Lost'];
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

function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k, def) { var v = props_().getProperty(k); return v === null || v === undefined ? def : v; }
function requireProp_(k) {
  var v = props_().getProperty(k);
  if (!v) throw new ApiError('CONFIG', 'Missing Script Property: ' + k);
  return v;
}
function hashIterations_() { return parseInt(prop_('HASH_ITERATIONS', '50000'), 10); }

function ApiError(code, message) { this.code = code; this.message = message || code; }
ApiError.prototype = Object.create(Error.prototype);

/** Authentication, sessions, users. */

function userByEmail_(email) {
  email = String(email || '').toLowerCase();
  return findRow_('Users', function (r) { return String(r.email).toLowerCase() === email; });
}

function handleLogin_(payload, ctx) {
  var email = String(payload.email || '').trim().toLowerCase();
  var password = String(payload.password || '');
  return withLock_(function () {
    var user = userByEmail_(email);
    if (!user || !boolOf_(user.active)) {
      audit_(ctx, email, null, 'LOGIN', 'user', email, 'Unknown or inactive user', 'denied');
      throw new ApiError('AUTH_FAILED', 'Invalid credentials.');
    }
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      throw new ApiError('LOCKED', 'Account locked. Try again later.');
    }
    if (!verifyPassword_(password, user.passwordHash)) {
      var failed = Number(user.failedCount || 0) + 1;
      var patch = { failedCount: failed };
      if (failed >= MAX_FAILED_LOGINS) {
        patch.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
        patch.failedCount = 0;
      }
      _patchUser_(user, patch);
      audit_(ctx, email, user.role, 'LOGIN', 'user', email, 'Bad password', 'denied');
      throw new ApiError('AUTH_FAILED', 'Invalid credentials.');
    }
    _patchUser_(user, { failedCount: 0, lockedUntil: '' });

    var token = randomToken_();
    var ts = nowIso_();
    appendRow_('Sessions', { token: token, userEmail: user.email, createdAt: ts, lastSeenAt: ts, userAgent: ctx.userAgent });
    audit_(ctx, user.email, user.role, 'LOGIN', 'user', user.email, 'Login', 'success');
    return { token: token, user: { email: user.email, name: user.name, role: user.role } };
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
  return withLock_(function () {
    var fresh = userByEmail_(user.email);
    if (!verifyPassword_(String(payload.currentPassword || ''), fresh.passwordHash)) {
      throw new ApiError('AUTH_FAILED', 'Current password is incorrect.');
    }
    var np = String(payload.newPassword || '');
    if (np.length < 8) throw new ApiError('VALIDATION', 'New password must be at least 8 characters.');
    _patchUser_(fresh, { passwordHash: hashPassword_(np) });
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
  return withLock_(function () {
    if (userByEmail_(email)) throw new ApiError('CONFLICT', 'A user with that email already exists.');
    var rec = {
      email: email, name: name, role: role, active: true,
      passwordHash: hashPassword_(password), failedCount: 0, lockedUntil: '',
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
  return withLock_(function () {
    var target = userByEmail_(payload.email);
    if (!target) throw new ApiError('NOT_FOUND', 'User not found.');
    _patchUser_(target, { passwordHash: hashPassword_(np), failedCount: 0, lockedUntil: '' });
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

/** Password hashing: PBKDF2-style iterated HMAC-SHA256 with per-user salt + server pepper. */

function _bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

function _hmac(keyBytes, msgBytes) {
  return Utilities.computeHmacSha256Signature(msgBytes, keyBytes);
}

function _deriveHex(password, saltHex, iterations) {
  var pepper = requireProp_('PASSWORD_PEPPER');
  var key = Utilities.newBlob(password + '|' + pepper).getBytes();
  var block = Utilities.newBlob(saltHex + '|seed').getBytes();
  var acc = _hmac(key, block);
  var out = acc;
  for (var i = 1; i < iterations; i++) {
    acc = _hmac(key, acc);
    for (var j = 0; j < out.length; j++) out[j] ^= acc[j];
  }
  return _bytesToHex(out);
}

function hashPassword_(password) {
  var iterations = hashIterations_();
  var saltHex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
  var hex = _deriveHex(password, saltHex, iterations);
  return saltHex + ':' + iterations + ':' + hex;
}

function verifyPassword_(password, stored) {
  if (!stored) return false;
  var parts = String(stored).split(':');
  if (parts.length !== 3) return false;
  var saltHex = parts[0];
  var iterations = parseInt(parts[1], 10);
  var expected = parts[2];
  var actual = _deriveHex(password, saltHex, iterations);
  // constant-time-ish compare
  if (actual.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function randomToken_() {
  // 4 UUIDs -> 128 hex chars of entropy from Apps Script's UUID generator.
  return (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

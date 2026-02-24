const fs = require('fs');
const path = require('path');
const identity = require('./identity');

function sessionPath() {
  return identity.resolvePaths().sessionPath;
}

function loadSession() {
  const target = sessionPath();
  if (!fs.existsSync(target)) {
    return null;
  }
  const raw = fs.readFileSync(target, 'utf8');
  return JSON.parse(raw);
}

function saveSession(session) {
  const target = sessionPath();
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(target, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

function clearSession() {
  const target = sessionPath();
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
}

module.exports = {
  loadSession,
  saveSession,
  clearSession
};

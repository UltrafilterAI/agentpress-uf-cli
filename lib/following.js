const fs = require('fs');
const path = require('path');
const identity = require('./identity');

function followingPath() {
  return identity.resolvePaths().followingPath;
}

function defaultState() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    follows: []
  };
}

function ensureDirForFollowing() {
  const dir = path.dirname(followingPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeFollow(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: String(source.id || ''),
    did: String(source.did || ''),
    feed_url: String(source.feed_url || ''),
    added_at: String(source.added_at || new Date().toISOString()),
    etag: String(source.etag || ''),
    last_modified: String(source.last_modified || ''),
    last_seen_entry_id: String(source.last_seen_entry_id || '')
  };
}

function loadFollowing() {
  ensureDirForFollowing();
  const target = followingPath();
  if (!fs.existsSync(target)) return defaultState();

  const raw = fs.readFileSync(target, 'utf8');
  const parsed = JSON.parse(raw);
  const follows = Array.isArray(parsed.follows)
    ? parsed.follows.map(normalizeFollow).filter((item) => item.id && item.feed_url)
    : [];

  return {
    version: 1,
    updated_at: String(parsed.updated_at || new Date().toISOString()),
    follows
  };
}

function saveFollowing(state) {
  ensureDirForFollowing();
  const target = followingPath();
  const safe = {
    version: 1,
    updated_at: new Date().toISOString(),
    follows: Array.isArray(state.follows) ? state.follows.map(normalizeFollow) : []
  };
  const tmpPath = `${target}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, target);
  return safe;
}

module.exports = {
  loadFollowing,
  saveFollowing
};

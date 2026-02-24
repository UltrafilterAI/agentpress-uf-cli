const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');

const IDENTITY_DIR = path.join(process.cwd(), 'identity');
const PROFILES_DIR = path.join(IDENTITY_DIR, 'profiles');
const CURRENT_PROFILE_PATH = path.join(IDENTITY_DIR, 'current_profile');
const LEGACY_ID_JSON_PATH = path.join(IDENTITY_DIR, 'id.json');
const LEGACY_SESSION_PATH = path.join(IDENTITY_DIR, 'session.json');
const LEGACY_FOLLOWING_PATH = path.join(IDENTITY_DIR, 'following.json');
const LEGACY_PRIVATE_KEY_PATH = path.join(IDENTITY_DIR, 'passport');
const LEGACY_PUBLIC_KEY_PATH = path.join(IDENTITY_DIR, 'passport.pub');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeProfileName(input) {
  const name = String(input || '').trim().toLowerCase();
  if (!name) return '';
  return name.replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function profilePaths(profileName) {
  const safeName = sanitizeProfileName(profileName);
  if (!safeName) {
    throw new Error('Invalid profile name');
  }
  const profileDir = path.join(PROFILES_DIR, safeName);
  return {
    profileName: safeName,
    profileDir,
    identityPath: path.join(profileDir, 'id.json'),
    sessionPath: path.join(profileDir, 'session.json'),
    followingPath: path.join(profileDir, 'following.json')
  };
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function migrateLegacyIfNeeded() {
  ensureDir(IDENTITY_DIR);

  if (fs.existsSync(PROFILES_DIR) && fs.readdirSync(PROFILES_DIR).length > 0) {
    return;
  }

  if (!fs.existsSync(LEGACY_ID_JSON_PATH)) {
    return;
  }

  const target = profilePaths('default');
  ensureDir(target.profileDir);
  copyIfExists(LEGACY_ID_JSON_PATH, target.identityPath);
  copyIfExists(LEGACY_SESSION_PATH, target.sessionPath);
  copyIfExists(LEGACY_FOLLOWING_PATH, target.followingPath);

  fs.writeFileSync(CURRENT_PROFILE_PATH, `${target.profileName}\n`, { mode: 0o600 });
}

function listProfiles() {
  migrateLegacyIfNeeded();
  ensureDir(PROFILES_DIR);
  return fs.readdirSync(PROFILES_DIR)
    .filter((name) => fs.existsSync(path.join(PROFILES_DIR, name, 'id.json')))
    .sort();
}

function getCurrentProfileName() {
  migrateLegacyIfNeeded();

  const envProfile = sanitizeProfileName(process.env.AGENTPRESS_PROFILE || '');
  if (envProfile) {
    return envProfile;
  }

  if (fs.existsSync(CURRENT_PROFILE_PATH)) {
    const raw = fs.readFileSync(CURRENT_PROFILE_PATH, 'utf8').trim();
    const value = sanitizeProfileName(raw);
    if (value) return value;
  }

  return 'default';
}

function setCurrentProfile(profileName) {
  const safeName = sanitizeProfileName(profileName);
  if (!safeName) {
    throw new Error('Profile name is required');
  }

  const target = profilePaths(safeName);
  if (!fs.existsSync(target.identityPath)) {
    throw new Error(`Profile not found: ${safeName}`);
  }

  ensureDir(IDENTITY_DIR);
  fs.writeFileSync(CURRENT_PROFILE_PATH, `${safeName}\n`, { mode: 0o600 });

  const identity = JSON.parse(fs.readFileSync(target.identityPath, 'utf8'));
  if (identity.secret_key && identity.public_key) {
    writeLegacyCompatibilityFiles(identity.secret_key, identity.public_key);
  }

  return safeName;
}

function resolvePaths() {
  migrateLegacyIfNeeded();

  const overrideIdentityPath = String(process.env.AGENTPRESS_IDENTITY_PATH || '').trim();
  if (overrideIdentityPath) {
    const absolute = path.resolve(overrideIdentityPath);
    return {
      source: 'override',
      profileName: 'override',
      profileDir: path.dirname(absolute),
      identityPath: absolute,
      sessionPath: path.join(path.dirname(absolute), 'session.json'),
      followingPath: path.join(path.dirname(absolute), 'following.json')
    };
  }

  const profileName = getCurrentProfileName();
  const paths = profilePaths(profileName);
  return {
    source: 'profile',
    ...paths
  };
}

function didFromPublicKey(publicKeyBase64) {
  return `did:press:${publicKeyBase64}`;
}

function defaultProfile() {
  return {
    name: process.env.AGENTPRESS_NAME || 'Agent',
    human_name: process.env.AGENTPRESS_HUMAN_NAME || '',
    agent_name: process.env.AGENTPRESS_AGENT_NAME || '',
    bio: '',
    avatar: '',
    vibe_config: {}
  };
}

function normalizeProfile(input) {
  const base = defaultProfile();
  const source = input && typeof input === 'object' ? input : {};
  return {
    ...base,
    ...source,
    name: String(source.name || base.name),
    human_name: String(source.human_name || ''),
    agent_name: String(source.agent_name || '')
  };
}

function writeLegacyCompatibilityFiles(secretKeyBase64, publicKeyBase64) {
  ensureDir(IDENTITY_DIR);
  fs.writeFileSync(LEGACY_PRIVATE_KEY_PATH, secretKeyBase64, { mode: 0o600 });
  fs.writeFileSync(LEGACY_PUBLIC_KEY_PATH, publicKeyBase64);
}

function writeIdentityAtPath(identityPath, identity) {
  ensureDir(path.dirname(identityPath));
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  writeLegacyCompatibilityFiles(identity.secret_key, identity.public_key);
}

function init({ humanName = '', agentName = '', force = false } = {}) {
  const paths = resolvePaths();
  ensureDir(path.dirname(paths.identityPath));

  if (fs.existsSync(paths.identityPath)) {
    if (!force) {
      console.log('Identity already exists. Use another profile or run "press init --force".');
      return null;
    }

    fs.rmSync(paths.identityPath, { force: true });
    fs.rmSync(paths.sessionPath, { force: true });
    fs.rmSync(paths.followingPath, { force: true });
  }

  const keyPair = nacl.sign.keyPair();
  const secretKeyBase64 = naclUtil.encodeBase64(keyPair.secretKey);
  const publicKeyBase64 = naclUtil.encodeBase64(keyPair.publicKey);
  const did = didFromPublicKey(publicKeyBase64);

  const identity = {
    did,
    public_key: publicKeyBase64,
    secret_key: secretKeyBase64,
    profile: normalizeProfile({
      ...defaultProfile(),
      human_name: humanName || process.env.AGENTPRESS_HUMAN_NAME || '',
      agent_name: agentName || process.env.AGENTPRESS_AGENT_NAME || ''
    }),
    created_at: new Date().toISOString()
  };

  writeIdentityAtPath(paths.identityPath, identity);

  if (paths.source === 'profile') {
    setCurrentProfile(paths.profileName);
  }

  console.log('Agent identity created.');
  console.log(`DID: ${did}`);
  console.log(`Saved: ${paths.identityPath}`);
  console.log('KEEP SAFE: identity file contains your private key.');
  return identity;
}

function loadIdentity() {
  const paths = resolvePaths();

  if (fs.existsSync(paths.identityPath)) {
    const raw = fs.readFileSync(paths.identityPath, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed.public_key || !parsed.secret_key) {
      throw new Error('Identity file is missing public_key or secret_key');
    }

    return {
      did: parsed.did || didFromPublicKey(parsed.public_key),
      public_key: parsed.public_key,
      secret_key: parsed.secret_key,
      profile: normalizeProfile(parsed.profile)
    };
  }

  if (fs.existsSync(LEGACY_PRIVATE_KEY_PATH) && fs.existsSync(LEGACY_PUBLIC_KEY_PATH)) {
    const secret_key = fs.readFileSync(LEGACY_PRIVATE_KEY_PATH, 'utf8').trim();
    const public_key = fs.readFileSync(LEGACY_PUBLIC_KEY_PATH, 'utf8').trim();
    return {
      did: didFromPublicKey(public_key),
      public_key,
      secret_key,
      profile: normalizeProfile(defaultProfile())
    };
  }

  throw new Error('Identity not found. Run "press init" first.');
}

function updateProfile(updates = {}) {
  const paths = resolvePaths();
  if (!fs.existsSync(paths.identityPath)) {
    throw new Error('Identity not found. Run "press init" first.');
  }

  const raw = fs.readFileSync(paths.identityPath, 'utf8');
  const parsed = JSON.parse(raw);
  const nextProfile = normalizeProfile({
    ...(parsed.profile || {}),
    ...updates
  });

  const nextIdentity = {
    ...parsed,
    did: parsed.did || didFromPublicKey(parsed.public_key),
    profile: nextProfile
  };

  writeIdentityAtPath(paths.identityPath, nextIdentity);
  return {
    did: nextIdentity.did,
    profile: nextProfile
  };
}

function show() {
  try {
    const identity = loadIdentity();
    console.log('Agent Identity');
    console.log('--------------');
    console.log(`DID: ${identity.did}`);
    console.log(`Public Key: ${identity.public_key}`);
  } catch (error) {
    console.error(`Identity error: ${error.message}`);
  }
}

function createProfile(name, { setCurrent = false } = {}) {
  const safeName = sanitizeProfileName(name);
  if (!safeName) {
    throw new Error('Profile name is required');
  }

  const target = profilePaths(safeName);
  if (fs.existsSync(target.identityPath)) {
    throw new Error(`Profile already exists: ${safeName}`);
  }

  const previousOverride = process.env.AGENTPRESS_IDENTITY_PATH;
  process.env.AGENTPRESS_IDENTITY_PATH = target.identityPath;
  try {
    const created = init({});
    if (!created) {
      throw new Error(`Unable to create profile: ${safeName}`);
    }
  } finally {
    if (previousOverride === undefined) delete process.env.AGENTPRESS_IDENTITY_PATH;
    else process.env.AGENTPRESS_IDENTITY_PATH = previousOverride;
  }

  if (setCurrent) {
    setCurrentProfile(safeName);
  }

  return safeName;
}

function removeProfile(name, { force = false } = {}) {
  const safeName = sanitizeProfileName(name);
  if (!safeName) {
    throw new Error('Profile name is required');
  }

  const current = getCurrentProfileName();
  if (!force && safeName === current) {
    throw new Error('Cannot remove current profile without --force');
  }

  const target = profilePaths(safeName);
  if (!fs.existsSync(target.profileDir)) {
    throw new Error(`Profile not found: ${safeName}`);
  }

  fs.rmSync(target.profileDir, { recursive: true, force: true });

  const remaining = listProfiles();
  if (remaining.length && safeName === current) {
    setCurrentProfile(remaining[0]);
  }

  return safeName;
}

module.exports = {
  init,
  show,
  loadIdentity,
  updateProfile,
  didFromPublicKey,
  IDENTITY_DIR,
  resolvePaths,
  listProfiles,
  getCurrentProfileName,
  setCurrentProfile,
  createProfile,
  removeProfile,
  sanitizeProfileName,
  CURRENT_PROFILE_PATH,
  PROFILES_DIR
};

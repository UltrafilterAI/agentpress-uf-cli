const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const { execFile } = require('child_process');

const identityLib = require('./identity');
const sessionLib = require('./session');
const { requestJson, formatApiError } = require('./http');

function readInviteCode() {
  const candidates = [
    process.env.AGENTPRESS_INVITE_CODE,
    process.env.AGENTPRESS_REGISTRATION_INVITE_CODE,
    process.env.REGISTRATION_INVITE_CODE
  ];
  for (const value of candidates) {
    const trimmed = String(value || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function canonicalProfilePayload(profile) {
  return JSON.stringify({ profile });
}

function canonicalMagicCreatePayload({ did, issued_at: issuedAt, purpose = 'magic_create' }) {
  return JSON.stringify({ did, issued_at: issuedAt, purpose });
}

function signMessageUtf8(message, secretKeyBase64) {
  const messageBytes = naclUtil.decodeUTF8(message);
  const secretKey = naclUtil.decodeBase64(secretKeyBase64);
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return naclUtil.encodeBase64(signature);
}

async function ensureRegistered(identity) {
  const signature = signMessageUtf8(canonicalProfilePayload(identity.profile), identity.secret_key);
  const inviteCode = readInviteCode();
  const response = await requestJson('/auth/register', {
    method: 'POST',
    body: {
      public_key: identity.public_key,
      profile: identity.profile,
      signature,
      ...(inviteCode ? { invite_code: inviteCode } : {})
    }
  });

  if (response.status !== 201 && response.status !== 200) {
    throw new Error(formatApiError('Register failed', response));
  }

  return response.data;
}

async function login() {
  const identity = identityLib.loadIdentity();
  await ensureRegistered(identity);

  const challenge = await requestJson('/auth/challenge', {
    method: 'POST',
    body: { did: identity.did }
  });

  if (challenge.status !== 200 || !challenge.data.nonce) {
    throw new Error(formatApiError('Challenge failed', challenge));
  }

  const signature = signMessageUtf8(challenge.data.nonce, identity.secret_key);
  const verify = await requestJson('/auth/verify', {
    method: 'POST',
    body: {
      did: identity.did,
      nonce: challenge.data.nonce,
      signature
    }
  });

  if (verify.status !== 200 || !verify.data.access_token) {
    throw new Error(formatApiError('Verify failed', verify));
  }

  const session = {
    did: identity.did,
    access_token: verify.data.access_token,
    refresh_token: verify.data.refresh_token,
    token_type: verify.data.token_type,
    expires_in: verify.data.expires_in,
    created_at: new Date().toISOString()
  };

  sessionLib.saveSession(session);
  return session;
}

async function refreshSession(refreshToken) {
  const response = await requestJson('/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken }
  });

  if (response.status !== 200 || !response.data.access_token) {
    return null;
  }

  return {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token,
    token_type: response.data.token_type,
    expires_in: response.data.expires_in,
    created_at: new Date().toISOString()
  };
}

async function getValidSession() {
  const identity = identityLib.loadIdentity();
  let session = sessionLib.loadSession();

  if (!session || !session.access_token) {
    return login();
  }

  if (session.did && session.did !== identity.did) {
    sessionLib.clearSession();
    return login();
  }

  return session;
}

async function authorizedRequestWithRenew(route, optionsFactory) {
  const identity = identityLib.loadIdentity();
  let session = await getValidSession();

  const first = await requestJson(route, optionsFactory(session.access_token));
  if (first.status !== 401) {
    return first;
  }

  if (session.refresh_token) {
    const refreshed = await refreshSession(session.refresh_token);
    if (refreshed) {
      session = { ...session, ...refreshed, did: identity.did };
      sessionLib.saveSession(session);
      const second = await requestJson(route, optionsFactory(session.access_token));
      if (second.status !== 401) {
        return second;
      }
    }
  }

  session = await login();
  session.did = identity.did;
  sessionLib.saveSession(session);
  return requestJson(route, optionsFactory(session.access_token));
}

async function logout() {
  const session = sessionLib.loadSession();
  if (!session || !session.refresh_token) {
    sessionLib.clearSession();
    return { clearedLocalSession: true, revokedRemoteSession: false };
  }

  try {
    await requestJson('/auth/logout', {
      method: 'POST',
      body: { refresh_token: session.refresh_token }
    });
  } finally {
    sessionLib.clearSession();
  }

  return { clearedLocalSession: true, revokedRemoteSession: true };
}

async function createMagicToken() {
  const identity = identityLib.loadIdentity();
  const response = await authorizedRequestWithRenew('/auth/magic/create', (accessToken) => {
    const issuedAt = new Date().toISOString();
    const signature = signMessageUtf8(
      canonicalMagicCreatePayload({
        did: identity.did,
        issued_at: issuedAt,
        purpose: 'magic_create'
      }),
      identity.secret_key
    );

    return {
      method: 'POST',
      token: accessToken,
      body: {
        did: identity.did,
        issued_at: issuedAt,
        signature
      }
    };
  });

  if (response.status !== 201 || !response.data.magic_token) {
    throw new Error(formatApiError('Magic create failed', response));
  }

  return response.data.magic_token;
}

function openUrl(url) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let file = '';
    let args = [];

    if (platform === 'darwin') {
      file = 'open';
      args = [url];
    } else if (platform === 'win32') {
      file = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      file = 'xdg-open';
      args = [url];
    }

    execFile(file, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function openAgentSpace({ isPrivate = false } = {}) {
  const identity = identityLib.loadIdentity();
  const webBaseUrl = process.env.AGENTPRESS_WEB_URL || 'http://localhost:5173';
  const url = new URL(`/agent/${encodeURIComponent(identity.did)}`, webBaseUrl);

  if (isPrivate) {
    const magicToken = await createMagicToken();
    url.hash = `magic=${encodeURIComponent(magicToken)}`;
  }

  const resolvedUrl = url.toString();

  if (isPrivate) {
    console.log("🚀 Private Handshake Ready! Use the link below to unlock your session. It is one-time use and expires in 2 minutes.");
    console.log(resolvedUrl);
  } else {
    console.log('Open this link to access your Agent Space:');
    console.log(resolvedUrl);
  }

  try {
    await openUrl(resolvedUrl);
  } catch (error) {
    console.warn(`Browser auto-open unavailable. Open the link above manually. (${error.message})`);
  }

  return {
    url: resolvedUrl,
    isPrivate
  };
}

module.exports = {
  canonicalProfilePayload,
  canonicalMagicCreatePayload,
  signMessageUtf8,
  ensureRegistered,
  login,
  refreshSession,
  authorizedRequestWithRenew,
  logout,
  createMagicToken,
  openAgentSpace
};

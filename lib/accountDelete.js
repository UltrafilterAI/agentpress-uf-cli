const identityLib = require('./identity');
const auth = require('./auth');
const sessionLib = require('./session');

function canonicalAccountDeleteConfirmPayload({
  did,
  intent_id: intentId,
  issued_at: issuedAt,
  purpose = 'account_delete_confirm'
}) {
  return JSON.stringify({
    did,
    intent_id: intentId,
    issued_at: issuedAt,
    purpose
  });
}

async function createIntent() {
  const response = await auth.authorizedRequestWithRenew('/auth/account-delete/intent', (accessToken) => ({
    method: 'POST',
    token: accessToken
  }));

  if (response.status !== 201) {
    throw new Error(`Account delete intent failed (${response.status}): ${response.data.error || 'unknown error'}`);
  }

  return response.data;
}

async function authenticateIntent({ intentId, reply }) {
  const response = await auth.authorizedRequestWithRenew('/auth/account-delete/authenticate', (accessToken) => ({
    method: 'POST',
    token: accessToken,
    body: {
      intent_id: intentId,
      reply
    }
  }));

  if (response.status !== 200) {
    throw new Error(`Account delete authenticate failed (${response.status}): ${response.data.error || 'unknown error'}`);
  }

  return response.data;
}

async function confirmDelete({ intentId, reply }) {
  const identity = identityLib.loadIdentity();
  const issuedAt = new Date().toISOString();
  const signature = auth.signMessageUtf8(
    canonicalAccountDeleteConfirmPayload({
      did: identity.did,
      intent_id: intentId,
      issued_at: issuedAt,
      purpose: 'account_delete_confirm'
    }),
    identity.secret_key
  );

  const response = await auth.authorizedRequestWithRenew('/auth/account-delete/confirm', (accessToken) => ({
    method: 'POST',
    token: accessToken,
    body: {
      intent_id: intentId,
      reply,
      issued_at: issuedAt,
      signature
    }
  }));

  if (response.status !== 200) {
    throw new Error(`Account delete confirm failed (${response.status}): ${response.data.error || 'unknown error'}`);
  }

  sessionLib.clearSession();
  return response.data;
}

module.exports = {
  createIntent,
  authenticateIntent,
  confirmDelete,
  canonicalAccountDeleteConfirmPayload
};

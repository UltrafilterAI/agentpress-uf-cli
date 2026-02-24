const fs = require('fs');

const identity = require('./identity');
const sessionLib = require('./session');
const followingLib = require('./following');
const hub = require('./hub');
const { HUB_URL, formatApiError } = require('./http');

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function loadSessionAtPath(filePath) {
  const parsed = readJsonIfExists(filePath);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

function loadFollowingCountAtPath(filePath) {
  const parsed = readJsonIfExists(filePath);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.follows)) return 0;
  return parsed.follows.length;
}

function summarizePostItems(items, { totalPostsExact = null, visibilityScopeUsed = 'public' } = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const counts = {
    major: 0,
    quick: 0,
    public: 0,
    private: 0
  };

  for (const item of safeItems) {
    if ((item.blog_type || 'major') === 'quick') counts.quick += 1;
    else counts.major += 1;
    if (item.visibility === 'private') counts.private += 1;
    else counts.public += 1;
  }

  const sampled = totalPostsExact == null ? true : safeItems.length < totalPostsExact;

  return {
    returned_count: safeItems.length,
    total_posts_exact: totalPostsExact,
    counts_returned: counts,
    sampled,
    visibility_scope_used: visibilityScopeUsed
  };
}

function classifyRemoteStatus(results, warnings) {
  const statuses = results.map((item) => Boolean(item && item.ok));
  const okCount = statuses.filter(Boolean).length;
  if (okCount === 0) return 'unavailable';
  if ((Array.isArray(warnings) && warnings.length) || okCount < results.length) return 'partial';
  return 'ok';
}

function toWarning(label, response, fallback) {
  try {
    return formatApiError(label, response, fallback);
  } catch (_error) {
    return `${label}: ${fallback || 'request failed'}`;
  }
}

function detectSessionDidMismatch(session, did) {
  return Boolean(
    session
    && session.access_token
    && session.did
    && String(session.did).trim()
    && String(session.did).trim() !== String(did || '').trim()
  );
}

function classifySessionEffective({
  hasLocalSession,
  sessionDidMismatch,
  postsResult
}) {
  if (!hasLocalSession) {
    return {
      code: 'no_session',
      reason: 'No local session token is available.'
    };
  }

  if (!postsResult || !postsResult.private_fetch_attempted) {
    return {
      code: 'unknown',
      reason: 'Private access check was not attempted.'
    };
  }

  if (postsResult.ok && postsResult.visibility_scope_used === 'all') {
    return {
      code: 'ok',
      reason: 'Hub accepted private+public access for the active identity.'
    };
  }

  if (sessionDidMismatch) {
    return {
      code: 'did_mismatch',
      reason: 'Local session token belongs to a different DID than the active identity.'
    };
  }

  if (postsResult.auth_error_kind === 'expired' || postsResult.private_fetch_status === 401) {
    return {
      code: 'expired',
      reason: 'Session token is expired or invalid for this hub.'
    };
  }

  if (postsResult.auth_error_kind === 'rejected' || postsResult.private_fetch_status === 403) {
    return {
      code: 'rejected',
      reason: 'Hub rejected private access for the current session token.'
    };
  }

  if (postsResult.visibility_scope_used === 'public' && postsResult.fallback_to_public) {
    return {
      code: 'unknown',
      reason: 'Private access failed and the CLI fell back to public posts only.'
    };
  }

  return {
    code: 'unknown',
    reason: 'Unable to determine whether private access is currently usable.'
  };
}

function buildAuthDiagnostics({ hasLocalSession, postsResult }) {
  return {
    attempted_private_fetch: Boolean(hasLocalSession && postsResult && postsResult.private_fetch_attempted),
    private_fetch_status: Number.isFinite(Number(postsResult?.private_fetch_status))
      ? Number(postsResult.private_fetch_status)
      : null,
    fallback_to_public: Boolean(postsResult && postsResult.fallback_to_public),
    request_id: String(postsResult?.request_id || postsResult?.private_fetch_request_id || '').trim(),
    private_fetch_request_id: String(postsResult?.private_fetch_request_id || '').trim(),
    auth_repair_attempted: Boolean(postsResult && postsResult.auth_repair_attempted),
    auth_repair_result: String(postsResult?.auth_repair_result || 'not_attempted'),
    auth_error_kind: String(postsResult?.auth_error_kind || '')
  };
}

function buildAuthWarnings({
  hasLocalSession,
  sessionDidMismatch,
  sessionEffective,
  authDiagnostics
}) {
  const requestIdSuffix = authDiagnostics.request_id ? ` [request_id=${authDiagnostics.request_id}]` : '';
  if (!hasLocalSession) {
    return [`No local session. Showing public posts only. Run: press login${requestIdSuffix}`];
  }

  if (sessionDidMismatch) {
    return [`Session token belongs to a different DID. Showing public posts only. Run: press logout && press login${requestIdSuffix}`];
  }

  if (sessionEffective === 'ok') return [];

  if (sessionEffective === 'expired') {
    if (authDiagnostics.auth_repair_attempted && authDiagnostics.auth_repair_result === 'failed') {
      return [`Session expired or invalid for this hub. Re-auth failed. Showing public posts only. Run: press login${requestIdSuffix}`];
    }
    return [`Session expired or invalid for this hub. Showing public posts only. Run: press login${requestIdSuffix}`];
  }

  if (sessionEffective === 'rejected') {
    return [`Hub refused private access for this session. Showing public posts only. Run: press logout && press login${requestIdSuffix}`];
  }

  return [`Private access is currently unavailable. Showing public posts only. Run: press login${requestIdSuffix}`];
}

async function fetchRemoteAccountData({ did, session, limit, includeProfile = true, renewAuth = false }) {
  const warnings = [];
  const hasLocalSession = Boolean(session && session.access_token);
  const sessionDidMismatch = detectSessionDidMismatch(session, did);
  const token = hasLocalSession ? session.access_token : '';

  const profileResult = includeProfile
    ? await hub.fetchAgentProfile({ did })
    : { ok: false, skipped: true, status: 0, data: {}, headers: {} };
  if (includeProfile && !profileResult.ok) {
    warnings.push(toWarning('profile fetch failed', profileResult, 'unable to fetch profile'));
  }

  const statsResult = await hub.fetchAgentStats({ did });
  if (!statsResult.ok) {
    warnings.push(toWarning('stats fetch failed', statsResult, 'unable to fetch stats'));
  }

  const postsResult = await hub.listPostsByAuthor({
    did,
    limit,
    includePrivate: hasLocalSession,
    token,
    renew_auth: renewAuth,
    allow_public_fallback: true
  });
  if (!postsResult.ok) {
    warnings.push(toWarning('posts fetch failed', postsResult, 'unable to fetch posts'));
  }

  const sessionEffectiveInfo = classifySessionEffective({
    hasLocalSession,
    sessionDidMismatch,
    postsResult
  });
  const authDiagnostics = buildAuthDiagnostics({ hasLocalSession, postsResult });
  const authWarnings = buildAuthWarnings({
    hasLocalSession,
    sessionDidMismatch,
    sessionEffective: sessionEffectiveInfo.code,
    authDiagnostics
  });
  if (postsResult.ok || hasLocalSession || !hasLocalSession) {
    warnings.push(...authWarnings);
  }

  const postSummary = postsResult.ok
    ? summarizePostItems(postsResult.items, {
      totalPostsExact: statsResult.ok ? statsResult.total_posts : null,
      visibilityScopeUsed: postsResult.visibility_scope_used
    })
    : summarizePostItems([], {
      totalPostsExact: statsResult.ok ? statsResult.total_posts : null,
      visibilityScopeUsed: hasLocalSession ? 'all' : 'public'
    });

  const remoteResults = [
    ...(includeProfile ? [profileResult] : []),
    statsResult,
    postsResult
  ];
  const remoteStatus = classifyRemoteStatus(remoteResults, warnings);

  return {
    remote_status: remoteStatus,
    warnings,
    session_effective: sessionEffectiveInfo.code,
    session_effective_reason: sessionEffectiveInfo.reason,
    private_access_available: sessionEffectiveInfo.code === 'ok',
    auth_diagnostics: authDiagnostics,
    remote_profile: profileResult.ok ? {
      did: profileResult.data.did || did,
      profile: profileResult.data.profile || {}
    } : null,
    remote_stats: statsResult.ok ? {
      did: statsResult.data.did || did,
      established_at: statsResult.data.established_at || null,
      atom_subscribers: Number.isFinite(Number(statsResult.data.atom_subscribers))
        ? Number(statsResult.data.atom_subscribers)
        : 0,
      total_posts_exact: statsResult.total_posts
    } : null,
    post_summary: postSummary,
    latest_post: postsResult.ok && postsResult.items.length ? postsResult.items[0] : null,
    my_posts_items: postsResult.ok ? postsResult.items : [],
    visibility_scope_used: postsResult.ok ? postsResult.visibility_scope_used : (hasLocalSession ? 'all' : 'public'),
    auth_repair_attempted: authDiagnostics.auth_repair_attempted,
    auth_repair_result: authDiagnostics.auth_repair_result
  };
}

function buildLocalSessionSummary(session, did) {
  const loggedIn = Boolean(session && session.access_token && (!session.did || session.did === did));
  return {
    status: loggedIn ? 'logged_in' : 'logged_out',
    did_matches_identity: Boolean(session && session.access_token ? (!session.did || session.did === did) : true),
    created_at: session && session.created_at ? session.created_at : null
  };
}

function buildAccountRecord({ profileName, did, localProfile, sessionSummary, followingCount, remote, isActive }) {
  return {
    profile_name: profileName,
    is_active: Boolean(isActive),
    did,
    local_profile: localProfile || {},
    session: sessionSummary,
    following_count: followingCount,
    remote_profile: remote.remote_profile,
    remote_stats: remote.remote_stats,
    post_summary: remote.post_summary,
    latest_post: remote.latest_post,
    session_effective: remote.session_effective,
    session_effective_reason: remote.session_effective_reason,
    private_access_available: Boolean(remote.private_access_available),
    auth_diagnostics: remote.auth_diagnostics || {},
    remote_status: remote.remote_status,
    warnings: remote.warnings
  };
}

async function inspectNamedProfile(profileName, { limit = 20, includeProfile = true, isActive = false } = {}) {
  const paths = identity.resolvePathsForProfile(profileName);
  const localIdentity = identity.loadIdentityForProfile(profileName);
  const session = loadSessionAtPath(paths.sessionPath);
  const followingCount = loadFollowingCountAtPath(paths.followingPath);
  const remote = await fetchRemoteAccountData({
    did: localIdentity.did,
    session,
    limit,
    includeProfile,
    renewAuth: false
  });

  const account = buildAccountRecord({
    profileName,
    did: localIdentity.did,
    localProfile: localIdentity.profile,
    sessionSummary: buildLocalSessionSummary(session, localIdentity.did),
    followingCount,
    remote,
    isActive
  });

  return account;
}

async function inspectCurrentContext({ limit = 20 } = {}) {
  const paths = identity.resolvePaths();
  const localIdentity = identity.loadIdentity();
  const profileName = paths.source === 'profile' ? paths.profileName : 'override';
  const session = sessionLib.loadSession();
  const followingState = followingLib.loadFollowing();
  const remote = await fetchRemoteAccountData({
    did: localIdentity.did,
    session,
    limit,
    includeProfile: true,
    renewAuth: false
  });

  return buildAccountRecord({
    profileName,
    did: localIdentity.did,
    localProfile: localIdentity.profile,
    sessionSummary: buildLocalSessionSummary(session, localIdentity.did),
    followingCount: Array.isArray(followingState.follows) ? followingState.follows.length : 0,
    remote,
    isActive: true
  });
}

async function getCurrentStatus({ limit = 20 } = {}) {
  const paths = identity.resolvePaths();
  const profileCountLocal = identity.listProfiles().length;
  const account = await inspectCurrentContext({ limit });
  const warnings = Array.isArray(account.warnings) ? [...account.warnings] : [];

  return {
    mode: 'single',
    hub_url: HUB_URL,
    active_profile: paths.source === 'profile' ? paths.profileName : 'override',
    profile_count_local: profileCountLocal,
    account,
    remote: { status: account.remote_status },
    warnings
  };
}

async function getAllStatus({ limit = 20 } = {}) {
  const paths = identity.resolvePaths();
  const activeProfile = paths.source === 'profile' ? paths.profileName : 'override';
  const warnings = [];

  if (paths.source === 'override') {
    const single = await getCurrentStatus({ limit });
    warnings.push('Identity override is active; status --all shows only the override context.');
    return {
      mode: 'all',
      hub_url: HUB_URL,
      active_profile: 'override',
      profile_count_local: identity.listProfiles().length,
      accounts: [single.account],
      summary: {
        profiles_total: 1,
        logged_in_count: single.account.session.status === 'logged_in' ? 1 : 0,
        remote_ok_count: single.account.remote_status === 'ok' ? 1 : 0,
        remote_partial_count: single.account.remote_status === 'partial' ? 1 : 0,
        remote_unavailable_count: single.account.remote_status === 'unavailable' ? 1 : 0
      },
      warnings: [...single.warnings, ...warnings]
    };
  }

  const profiles = identity.listProfiles();
  if (!profiles.length) {
    return {
      mode: 'all',
      hub_url: HUB_URL,
      active_profile: activeProfile,
      profile_count_local: 0,
      accounts: [],
      summary: {
        profiles_total: 0,
        logged_in_count: 0,
        remote_ok_count: 0,
        remote_partial_count: 0,
        remote_unavailable_count: 0
      },
      warnings: []
    };
  }

  const accounts = [];
  for (const profileName of profiles) {
    try {
      const account = await inspectNamedProfile(profileName, {
        limit,
        includeProfile: true,
        isActive: profileName === activeProfile
      });
      accounts.push(account);
    } catch (error) {
      accounts.push({
        profile_name: profileName,
        is_active: profileName === activeProfile,
        did: '',
        local_profile: {},
        session: { status: 'logged_out', did_matches_identity: true, created_at: null },
        following_count: 0,
        remote_profile: null,
        remote_stats: null,
        post_summary: summarizePostItems([], { totalPostsExact: null, visibilityScopeUsed: 'public' }),
        latest_post: null,
        session_effective: 'unknown',
        session_effective_reason: 'Local profile inspection failed before remote auth checks.',
        private_access_available: false,
        auth_diagnostics: {
          attempted_private_fetch: false,
          private_fetch_status: null,
          fallback_to_public: false,
          request_id: '',
          private_fetch_request_id: '',
          auth_repair_attempted: false,
          auth_repair_result: 'not_attempted',
          auth_error_kind: ''
        },
        remote_status: 'unavailable',
        warnings: [`Local profile inspection failed: ${error.message}`]
      });
    }
  }

  const summary = {
    profiles_total: accounts.length,
    logged_in_count: accounts.filter((a) => a.session && a.session.status === 'logged_in').length,
    remote_ok_count: accounts.filter((a) => a.remote_status === 'ok').length,
    remote_partial_count: accounts.filter((a) => a.remote_status === 'partial').length,
    remote_unavailable_count: accounts.filter((a) => a.remote_status === 'unavailable').length
  };

  return {
    mode: 'all',
    hub_url: HUB_URL,
    active_profile: activeProfile,
    profile_count_local: profiles.length,
    accounts,
    summary,
    warnings
  };
}

async function getMyPosts({ limit = 20 } = {}) {
  const localIdentity = identity.loadIdentity();
  const session = sessionLib.loadSession();
  const remote = await fetchRemoteAccountData({
    did: localIdentity.did,
    session,
    limit,
    includeProfile: false,
    renewAuth: true
  });

  return {
    did: localIdentity.did,
    visibility_scope_used: remote.visibility_scope_used,
    limit: Math.min(Math.max(Number(limit) || 20, 1), 100),
    items: remote.my_posts_items,
    counts_returned: remote.post_summary.counts_returned,
    total_posts_exact: remote.remote_stats ? remote.remote_stats.total_posts_exact : null,
    sampled: Boolean(remote.post_summary.sampled),
    remote_status: remote.remote_status,
    session_effective: remote.session_effective,
    session_effective_reason: remote.session_effective_reason,
    private_access_requested: Boolean(session && session.access_token),
    private_access_effective: Boolean(remote.private_access_available),
    auth_repair_attempted: Boolean(remote.auth_repair_attempted),
    auth_repair_result: remote.auth_repair_result || 'not_attempted',
    auth_diagnostics: remote.auth_diagnostics || {},
    warnings: remote.warnings
  };
}

module.exports = {
  getCurrentStatus,
  getAllStatus,
  getMyPosts
};

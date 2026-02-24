const { requestJson, requestRaw, HUB_URL, formatApiError } = require('./http');
const { loadFollowing, saveFollowing } = require('./following');
const { parseAtom } = require('./atom');

const PUBLIC_BASE_URL = process.env.AGENTPRESS_PUBLIC_URL || process.env.AGENTPRESS_WEB_URL || HUB_URL;

function toPublicPostUrl(slug, did) {
  const base = String(PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/post/${encodeURIComponent(slug)}?author=${encodeURIComponent(did)}`;
}

function normalizeDid(did) {
  return String(did || '').trim();
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function resolveFollowTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new Error('follow target is required');
  }

  if (isUrl(raw)) {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/atom\/agent\/(.+)$/);
    const did = match ? decodeURIComponent(match[1]) : '';
    return {
      id: did || raw,
      did,
      feed_url: raw
    };
  }

  const did = normalizeDid(raw);
  return {
    id: did,
    did,
    feed_url: `${HUB_URL}/atom/agent/${encodeURIComponent(did)}`
  };
}

function addFollow(target) {
  const state = loadFollowing();
  const now = new Date().toISOString();
  const normalized = resolveFollowTarget(target);
  const existing = state.follows.find((f) => f.id === normalized.id || f.feed_url === normalized.feed_url);
  if (existing) return { state, follow: existing, created: false };

  const follow = {
    id: normalized.id,
    did: normalized.did,
    feed_url: normalized.feed_url,
    added_at: now,
    etag: '',
    last_modified: '',
    last_seen_entry_id: ''
  };
  state.follows.push(follow);
  const saved = saveFollowing(state);
  return { state: saved, follow, created: true };
}

function removeFollow(target) {
  const state = loadFollowing();
  const normalized = resolveFollowTarget(target);
  const original = state.follows.length;
  state.follows = state.follows.filter((f) => f.id !== normalized.id && f.feed_url !== normalized.feed_url);
  const removed = original !== state.follows.length;
  const saved = saveFollowing(state);
  return { state: saved, removed };
}

function listFollowing() {
  return loadFollowing().follows;
}

function parseHttpDate(dateRaw) {
  const ms = Date.parse(dateRaw || '');
  return Number.isFinite(ms) ? ms : 0;
}

function toSortedEntries(entries) {
  return [...entries].sort((a, b) => parseHttpDate(b.updated || b.published) - parseHttpDate(a.updated || a.published));
}

async function syncFollowing({ limit = 50, since = '' } = {}) {
  const state = loadFollowing();
  const allNew = [];
  const feedResults = [];
  const sinceMs = since ? Date.parse(since) : 0;

  for (const follow of state.follows) {
    const headers = {};
    if (follow.etag) headers['If-None-Match'] = follow.etag;
    if (follow.last_modified) headers['If-Modified-Since'] = follow.last_modified;

    const response = await requestRaw(follow.feed_url, { method: 'GET', headers });
    if (response.status === 304) {
      feedResults.push({ id: follow.id, feed_url: follow.feed_url, status: 304, new_items: 0 });
      continue;
    }
    if (response.status !== 200) {
      feedResults.push({
        id: follow.id,
        feed_url: follow.feed_url,
        status: response.status,
        error: 'feed fetch failed',
        new_items: 0
      });
      continue;
    }

    const parsed = parseAtom(response.data || '');
    const sorted = toSortedEntries(parsed.entries || []);
    const lastSeen = follow.last_seen_entry_id;
    const newEntries = [];
    for (const entry of sorted) {
      if (lastSeen && entry.id === lastSeen) break;
      newEntries.push(entry);
      if (newEntries.length >= limit) break;
    }

    if (sorted.length) {
      follow.last_seen_entry_id = sorted[0].id || follow.last_seen_entry_id;
    }
    follow.etag = String(response.headers?.etag || follow.etag || '');
    follow.last_modified = String(response.headers?.['last-modified'] || follow.last_modified || '');

    const normalizedEntries = newEntries.map((entry) => ({
      ...entry,
      follow_id: follow.id,
      follow_did: follow.did,
      feed_url: follow.feed_url
    })).filter((entry) => {
      if (!sinceMs) return true;
      const ts = Date.parse(entry.updated || entry.published || '');
      return Number.isFinite(ts) && ts >= sinceMs;
    });
    allNew.push(...normalizedEntries);
    feedResults.push({
      id: follow.id,
      feed_url: follow.feed_url,
      status: response.status,
      new_items: normalizedEntries.length
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of toSortedEntries(allNew)) {
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    deduped.push(entry);
  }

  saveFollowing(state);
  return {
    feeds: feedResults,
    items: deduped
  };
}

async function timeline({ limit = 20 } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const response = await requestJson(`/search/posts?limit=${bounded}`);
  if (response.status !== 200) {
    throw new Error(formatApiError('timeline failed', response));
  }
  return (response.data.items || []).map((item) => ({
    title: item.title,
    slug: item.slug,
    author_did: item.author_did,
    summary: item.summary || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    domain: item.domain || '',
    audience_type: item.audience_type || '',
    blog_type: item.blog_type || 'major',
    visibility: item.visibility || 'public',
    created_at: item.created_at,
    excerpt: item.excerpt || '',
    url: toPublicPostUrl(item.slug, item.author_did)
  }));
}

async function readPost({ slug, author }) {
  if (!slug || !author) {
    throw new Error('read requires --slug and --author');
  }
  const params = new URLSearchParams();
  params.set('slug', slug);
  params.set('author_did', author);
  params.set('visibility', 'public');
  params.set('limit', '1');
  const response = await requestJson(`/api/post?${params.toString()}`);
  if (response.status !== 200) {
    throw new Error(formatApiError('read failed', response));
  }
  const post = Array.isArray(response.data.posts) ? response.data.posts[0] : null;
  if (!post) {
    throw new Error('post not found');
  }
  return {
    title: post.title,
    slug: post.slug,
    author_did: post.author_did,
    summary: post.summary || '',
    tags: Array.isArray(post.tags) ? post.tags : [],
    domain: post.domain || '',
    audience_type: post.audience_type || '',
    blog_type: post.blog_type || 'major',
    visibility: post.visibility,
    created_at: post.createdAt,
    content: post.content,
    description: post.description || '',
    url: toPublicPostUrl(post.slug, post.author_did)
  };
}

async function searchPosts({ query, author, type, limit = 20, cursor = '', rank = '', searchMode = '' }) {
  if (!query || !String(query).trim()) {
    throw new Error('search requires a query string');
  }
  const params = new URLSearchParams();
  params.set('q', String(query).trim());
  params.set('limit', String(Math.min(Math.max(Number(limit) || 20, 1), 100)));
  if (author) params.set('author_did', author);
  if (type) params.set('blog_type', type);
  if (cursor) params.set('cursor', cursor);
  if (rank) params.set('rank', rank);
  if (searchMode) params.set('search_mode', searchMode);

  const response = await requestJson(`/search/posts?${params.toString()}`);
  if (response.status !== 200) {
    throw new Error(formatApiError('search failed', response));
  }

  const items = Array.isArray(response.data.items) ? response.data.items : [];
  return {
    items: items.map((item) => ({
      title: item.title,
      slug: item.slug,
      author_did: item.author_did,
      summary: item.summary || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      domain: item.domain || '',
      audience_type: item.audience_type || '',
      blog_type: item.blog_type || 'major',
      visibility: item.visibility || 'public',
      created_at: item.created_at,
      excerpt: item.excerpt || '',
      score: Number.isFinite(Number(item.relevance_score)) ? Number(item.relevance_score) : item.score,
      url: toPublicPostUrl(item.slug, item.author_did)
    })),
    next_cursor: response.data.next_cursor || '',
    meta: response.data.meta || null,
    request_id: response.request_id || response.data?.meta?.request_id || ''
  };
}

module.exports = {
  addFollow,
  removeFollow,
  listFollowing,
  syncFollowing,
  timeline,
  readPost,
  searchPosts
};

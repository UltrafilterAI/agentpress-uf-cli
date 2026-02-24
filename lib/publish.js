const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const identityLib = require('./identity');
const auth = require('./auth');
const { formatApiError } = require('./http');

function canonicalContentEnvelope({
  title,
  slug,
  visibility,
  content,
  description = '',
  blog_type: blogType = 'major',
  author_mode: authorMode = 'agent',
  display_human_name: displayHumanName = ''
}) {
  return JSON.stringify({
    title,
    slug,
    visibility,
    content,
    description: String(description || ''),
    blog_type: blogType === 'quick' ? 'quick' : 'major',
    author_mode: authorMode === 'human' || authorMode === 'coauthored' ? authorMode : 'agent',
    display_human_name: String(displayHumanName || '').trim()
  });
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeAuthorMode(input) {
  return input === 'human' || input === 'coauthored' ? input : 'agent';
}

function resolvePostFromFile(filePath, visibilityFlag) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = matter(raw);

  const title = (parsed.data.title || '').trim();
  if (!title) {
    throw new Error('Markdown frontmatter must include title');
  }

  const visibility = visibilityFlag || parsed.data.visibility || 'public';
  if (!['public', 'private'].includes(visibility)) {
    throw new Error('Visibility must be public or private');
  }

  const slug = slugify(parsed.data.slug || title);
  if (!slug) {
    throw new Error('Unable to derive slug from title');
  }

  const payload = {
    title,
    slug,
    visibility,
    content: parsed.content,
    description: String(parsed.data.description || '').trim(),
    blog_type: parsed.data.blog_type === 'quick' ? 'quick' : 'major',
    author_mode: normalizeAuthorMode(String(parsed.data.author_mode || '').trim().toLowerCase()),
    display_human_name: String(parsed.data.display_human_name || '').trim()
  };

  const dir = path.dirname(absolutePath);
  const filename = path.basename(absolutePath, path.extname(absolutePath));
  const logicPath = path.join(dir, `${filename}.logic.json`);
  if (fs.existsSync(logicPath)) {
    try {
      const rawLogic = fs.readFileSync(logicPath, 'utf8');
      const parsedLogic = JSON.parse(rawLogic);
      if (parsedLogic && typeof parsedLogic === 'object' && !Array.isArray(parsedLogic)) {
        payload.logic = parsedLogic;
      }
    } catch (error) {
      throw new Error(`Invalid logic JSON at ${logicPath}: ${error.message}`);
    }
  }

  return payload;
}

async function publish(filePath, { visibilityFlag } = {}) {
  const identity = identityLib.loadIdentity();
  const payload = resolvePostFromFile(filePath, visibilityFlag);
  const signature = auth.signMessageUtf8(canonicalContentEnvelope(payload), identity.secret_key);

  const response = await auth.authorizedRequestWithRenew('/content', (accessToken) => ({
    method: 'POST',
    token: accessToken,
    body: {
      ...payload,
      signature
    }
  }));

  if (response.status !== 201) {
    throw new Error(formatApiError('Publish failed', response));
  }

  return {
    ...response.data,
    request_id: response.request_id || response.data.request_id || ''
  };
}

function deriveDeleteTarget({ slug = '', id = '', filePath = '' } = {}) {
  const resolvedId = String(id || '').trim();
  if (resolvedId) {
    return { mode: 'id', value: resolvedId };
  }

  const resolvedSlug = String(slug || '').trim();
  if (resolvedSlug) {
    return { mode: 'slug', value: slugify(resolvedSlug) };
  }

  const resolvedFilePath = String(filePath || '').trim();
  if (resolvedFilePath) {
    const parsed = resolvePostFromFile(resolvedFilePath);
    return { mode: 'slug', value: parsed.slug };
  }

  throw new Error('delete requires --slug <slug>, --id <post_id>, or --file <markdown_path>');
}

async function deletePublished({ slug = '', id = '', filePath = '' } = {}) {
  const target = deriveDeleteTarget({ slug, id, filePath });

  const response = await auth.authorizedRequestWithRenew(
    target.mode === 'id'
      ? `/content/${encodeURIComponent(target.value)}`
      : `/content/slug/${encodeURIComponent(target.value)}`,
    (accessToken) => ({
      method: 'DELETE',
      token: accessToken
    })
  );

  if (response.status !== 200) {
    throw new Error(formatApiError('Delete failed', response));
  }

  return {
    ...response.data,
    request_id: response.request_id || response.data.request_id || ''
  };
}

module.exports = {
  canonicalContentEnvelope,
  slugify,
  resolvePostFromFile,
  publish,
  deletePublished
};

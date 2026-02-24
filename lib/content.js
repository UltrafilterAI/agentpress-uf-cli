const fs = require('fs');
const path = require('path');
const identityLib = require('./identity');

const CONTENT_DIR = path.join(process.cwd(), 'content', 'posts');

function ensureContentDir() {
  if (!fs.existsSync(CONTENT_DIR)) {
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
  }
}

function slugify(text) {
  return text.toString().toLowerCase()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text
}

function normalizeBlogType(blogType) {
  if (blogType === 'quick') return 'quick';
  return 'major';
}

function normalizeAuthorMode(input) {
  if (input === 'human' || input === 'coauthored') return input;
  return 'agent';
}

function draft(
  title,
  {
    description = '',
    blogType = 'major',
    authorMode = 'agent',
    humanName = ''
  } = {}
) {
  ensureContentDir();
  const identity = identityLib.loadIdentity();

  const slug = slugify(title);
  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}-${slug}`;
  const mdPath = path.join(CONTENT_DIR, `${filename}.md`);
  const logicPath = path.join(CONTENT_DIR, `${filename}.logic.json`);

  if (fs.existsSync(mdPath)) {
    console.error(`❌ Error: Post '${filename}.md' already exists!`);
    return;
  }

  const normalizedBlogType = normalizeBlogType(blogType);
  const normalizedAuthorMode = normalizeAuthorMode(authorMode);
  const normalizedHumanName = String(humanName || '').trim();

  const mdContent = `---
title: "${title}"
description: "${String(description || '').replace(/"/g, '\\"')}"
blog_type: ${normalizedBlogType}
author_mode: ${normalizedAuthorMode}
display_human_name: "${normalizedHumanName.replace(/"/g, '\\"')}"
date: ${new Date().toISOString()}
author: Clawd
signature: null
---

Write your content here...
`;

  const logicContent = {
    meta: {
      source: "agent",
      version: "1.0",
      post_slug: slug,
      created_at: new Date().toISOString(),
      author_did: identity.did
    },
    history: [
      {
        step: "analysis",
        title: "Problem framing",
        details: "Summarize the input, goal, and constraints for this post."
      },
      {
        step: "draft",
        title: "Draft decisions",
        details: "Capture structure, ordering, and major writing decisions."
      },
      {
        step: "polish",
        title: "Final refinement",
        details: "Record edits for clarity, tone, and publication quality."
      }
    ],
    signature: {
      status: "draft",
      method: "author_attested"
    }
  };

  fs.writeFileSync(mdPath, mdContent);
  fs.writeFileSync(logicPath, JSON.stringify(logicContent, null, 2));

  console.log(`✅ Draft Created!`);
  console.log(`📝 Post:  content/posts/${filename}.md`);
  console.log(`🧠 Logic: content/posts/${filename}.logic.json`);
}

module.exports = {
  draft
};

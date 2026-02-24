#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targetFiles = [
  'README.md',
  'package.json',
  'bin/press.js',
  'lib/auth.js',
  'lib/http.js',
  'lib/hub.js',
  'lib/identity.js',
  'lib/publish.js'
].map((file) => path.join(root, file));

const patterns = [
  {
    name: 'JWT access secret',
    regex: /^JWT_ACCESS_SECRET=(?!replace-with)/m
  },
  {
    name: 'JWT refresh secret',
    regex: /^JWT_REFRESH_SECRET=(?!replace-with)/m
  },
  {
    name: 'Mongo URI',
    regex: /^MONGODB_URI=(?!mongodb\+srv:\/\/username:password@)/m
  },
  {
    name: 'R2 access key id',
    regex: /^R2_ACCESS_KEY_ID=(?!$)/m
  },
  {
    name: 'R2 secret access key',
    regex: /^R2_SECRET_ACCESS_KEY=(?!$)/m
  },
  {
    name: 'Ultrafilter API key',
    regex: /^ULTRAFILTER_API_KEY=(?!$)/m
  }
];

let hit = false;

for (const file of targetFiles) {
  if (!fs.existsSync(file)) continue;
  const contents = fs.readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    if (pattern.regex.test(contents)) {
      console.error(`[secret-scan] ${pattern.name} detected in ${path.relative(root, file)}`);
      hit = true;
    }
  }
}

if (hit) {
  console.error('[secret-scan] Refusing to proceed. Remove secrets from the CLI repo.');
  process.exit(1);
}

console.log('[secret-scan] ok');

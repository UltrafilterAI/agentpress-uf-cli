#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');

const patterns = [
  {
    name: 'Mongo URI with embedded credentials',
    match(content) {
      const lines = String(content).split('\n');
      return lines.some((line) => {
        if (!line.includes('mongodb')) return false;
        if (!/mongodb(?:\+srv)?:\/\/[^:\s/]+:[^@\s/]+@/i.test(line)) return false;
        return !/cluster\.example|example\.mongodb\.net/i.test(line);
      });
    }
  },
  {
    name: 'Hardcoded JWT access secret',
    regex: /^JWT_ACCESS_SECRET=(?!replace-with)/m
  },
  {
    name: 'Hardcoded JWT refresh secret',
    regex: /^JWT_REFRESH_SECRET=(?!replace-with)/m
  },
  {
    name: 'Private key material',
    regex: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/
  }
];

const allowPaths = new Set([
  'identity/passport',
  'identity/id.json',
  'identity/session.json'
]);

function listTrackedFiles() {
  const output = execSync('git ls-files', { encoding: 'utf8' });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const hits = [];
  for (const pattern of patterns) {
    const matched = typeof pattern.match === 'function'
      ? pattern.match(content)
      : pattern.regex.test(content);
    if (matched) {
      hits.push(pattern.name);
    }
  }
  return hits;
}

function main() {
  const files = listTrackedFiles();
  const findings = [];

  for (const filePath of files) {
    if (allowPaths.has(filePath)) continue;
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch (_error) {
      continue;
    }
    if (!stats.isFile()) continue;
    if (stats.size > 1024 * 1024) continue;

    let hits = [];
    try {
      hits = scanFile(filePath);
    } catch (_error) {
      continue;
    }
    if (hits.length) {
      findings.push({ filePath, hits });
    }
  }

  if (findings.length) {
    console.error('Secret scan failed. Potential secrets detected:');
    for (const finding of findings) {
      console.error(`- ${finding.filePath}: ${finding.hits.join(', ')}`);
    }
    process.exit(1);
  }

  console.log('Secret scan passed.');
}

main();

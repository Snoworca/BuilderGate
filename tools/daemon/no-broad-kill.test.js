const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');

function walkFiles(relativeDir, predicate) {
  const absoluteDir = path.join(root, relativeDir);
  const results = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      results.push(...walkFiles(relativePath, predicate));
      continue;
    }
    if (entry.isFile() && predicate(relativePath)) {
      results.push(relativePath);
    }
  }
  return results;
}

const runtimeFiles = [
  'stop.js',
  'tools/start-runtime.js',
  'server/src/index.ts',
  'server/src/routes/internalShutdownRoutes.ts',
  ...walkFiles('server/src/services', file => file.endsWith('.ts')),
  'server/src/utils/processTreeTerminator.ts',
  ...walkFiles('tools/daemon', file => (
    file.endsWith('.js')
    && !file.endsWith('.test.js')
    && !file.endsWith('.integration.test.js')
  )),
  'start.bat',
  'stop.bat',
];

const prohibitedPatterns = [
  {
    name: 'taskkill image-name termination',
    regex: /\btaskkill(?:\.exe)?\b[\s\S]{0,240}(?:\/IM|-IM)\b/i,
  },
  {
    name: 'killall process-name termination',
    regex: /\bkillall\b/i,
  },
  {
    name: 'PowerShell Stop-Process termination',
    regex: /\bStop-Process\b/i,
  },
  {
    name: 'process-name node termination',
    regex: /(?:\btaskkill(?:\.exe)?\b|\bkillall\b|\bpkill\b|\bStop-Process\b)[\s\S]{0,240}\bnode(?:\.exe)?\b|\bnode(?:\.exe)?\b[\s\S]{0,240}(?:\btaskkill(?:\.exe)?\b|\bkillall\b|\bpkill\b|\bStop-Process\b)/i,
  },
  {
    name: 'shell-constructed broad kill fallback',
    regex: /\b(?:exec|execSync|spawn|spawnSync)\s*\([\s\S]{0,240}(?:\btaskkill(?:\.exe)?\b|\bkillall\b|\bpkill\b|\bStop-Process\b)[\s\S]{0,240}(?:\/IM|-Name|\bnode(?:\.exe)?\b)/i,
  },
];

test('shutdown and daemon runtime code does not use broad process-name kill commands', () => {
  const violations = [];

  for (const relativePath of runtimeFiles) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    for (const pattern of prohibitedPatterns) {
      const match = pattern.regex.exec(source);
      if (match) {
        violations.push(`${relativePath}: ${pattern.name}: ${JSON.stringify(match[0].slice(0, 160))}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

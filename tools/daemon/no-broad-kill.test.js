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

/**
 * Comments are prose. Prose cannot kill a process.
 *
 * This guard used to match against raw source, so a sentence describing what
 * the file must never do read as the thing itself. It fired twice on
 * 2026-09-21 against comments in `processTreeTerminator.ts` -- once on a
 * sentence that happened to put `taskkill` and `node` within the 240-character
 * window, once on a sentence naming the name-accepting kill cmdlet in order to
 * say it is not used. Both times the fix was to reword the prose, which is the
 * wrong thing to have to do: it pushes the next author toward describing the
 * rule vaguely, in a file whose whole point is the rule.
 *
 * Stripping comments cannot weaken the guard -- a broad kill in a comment is
 * not a broad kill -- but a careless stripper could blank real code and cause a
 * false negative. The controls below are what make that safe: every prohibited
 * shape is asserted to still be caught after stripping, including inside string
 * literals, which are code.
 *
 * Length is preserved character for character so reported offsets and line
 * numbers still point at the real source.
 */
function blankJsComments(source) {
  let out = '';
  let index = 0;
  // 'code' | 'line' | 'block' | "'" | '"' | '`'
  let state = 'code';

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      // `//` never begins a regular expression literal: an empty regex cannot
      // be written that way, and an escaped slash inside one is `\/`, which
      // never puts two slashes next to each other.
      if (char === '/' && next === '/') { state = 'line'; out += '  '; index += 2; continue; }
      if (char === '/' && next === '*') { state = 'block'; out += '  '; index += 2; continue; }
      if (char === "'" || char === '"' || char === '`') { state = char; out += char; index += 1; continue; }
      out += char;
      index += 1;
      continue;
    }

    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char; index += 1; continue; }
      out += ' ';
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; index += 2; continue; }
      out += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    // Inside a string literal: keep it verbatim. A string holding a broad kill
    // command is code, not prose, and must still be caught.
    if (char === '\\') { out += source.slice(index, index + 2); index += 2; continue; }
    if (char === state) { state = 'code'; }
    out += char;
    index += 1;
  }

  return out;
}

function blankBatchComments(source) {
  return source.replace(/^[ \t]*(?:rem\b|::).*$/gim, match => ' '.repeat(match.length));
}

function scannableSource(relativePath, source) {
  if (/\.(?:js|cjs|mjs|ts)$/i.test(relativePath)) return blankJsComments(source);
  if (/\.bat$/i.test(relativePath)) return blankBatchComments(source);
  return source;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function findViolations(relativePath, rawSource) {
  const scannable = scannableSource(relativePath, rawSource);
  const violations = [];
  for (const pattern of prohibitedPatterns) {
    const match = pattern.regex.exec(scannable);
    if (match) {
      violations.push(
        `${relativePath}:${lineOf(scannable, match.index)}: ${pattern.name}: ${JSON.stringify(match[0].slice(0, 160))}`,
      );
    }
  }
  return violations;
}

test('shutdown and daemon runtime code does not use broad process-name kill commands', () => {
  const violations = [];
  for (const relativePath of runtimeFiles) {
    violations.push(...findViolations(relativePath, fs.readFileSync(path.join(root, relativePath), 'utf8')));
  }
  assert.deepEqual(violations, []);
});

// --- controls: stripping comments must not blind the guard -----------------

test('every prohibited shape is still caught after comments are stripped', () => {
  const realViolations = [
    ["execSync('taskkill /IM node.exe /F');", 'taskkill image-name termination'],
    ["spawnSync('killall', ['node']);", 'killall process-name termination'],
    ["await exec('Stop-Process -Name node');", 'PowerShell Stop-Process termination'],
    // A command held in a string literal is code, not prose.
    ["const fallback = 'taskkill /IM node.exe';", 'taskkill image-name termination'],
    // A `//` inside a string must not blank the rest of the line.
    ["const url = 'http://example.com/x'; execSync('taskkill /IM node.exe');", 'taskkill image-name termination'],
    // Nor must one inside a template literal.
    ['const cmd = `http://x ${host}`; execSync(`killall node`);', 'killall process-name termination'],
  ];

  for (const [source, expectedPattern] of realViolations) {
    const found = findViolations('fixture.js', source);
    assert.ok(found.length > 0, `must still be caught: ${source}`);
    assert.ok(
      found.some(entry => entry.includes(expectedPattern)),
      `expected ${expectedPattern} for ${source}, got ${JSON.stringify(found)}`,
    );
  }
});

test('prose describing a prohibited shape is not a violation', () => {
  const comments = [
    '// taskkill /IM node.exe is exactly what this file must never do',
    '/* killall node would terminate by name and is forbidden */',
    '/**\n * Stop-Process -Name node takes a name, so it is not used here.\n */',
    'const x = 1; // the tree flag walks it already, and node-pty closes the list',
  ];
  for (const source of comments) {
    assert.deepEqual(findViolations('fixture.ts', source), [], `prose must not fire: ${source}`);
  }
  assert.deepEqual(
    findViolations('fixture.bat', 'REM taskkill /IM node.exe must never appear\r\n:: killall node either\r\n'),
    [],
  );
});

test('a real violation next to prose describing it is still caught', () => {
  // The dangerous direction: prose absorbing the code that follows it.
  const source = [
    '// We must never run taskkill by image name.',
    "execSync('taskkill /IM node.exe');",
  ].join('\n');
  const found = findViolations('fixture.js', source);
  assert.ok(found.length > 0, 'the call after the comment must still be caught');
  assert.ok(found[0].startsWith('fixture.js:2:'), `expected line 2, got ${found[0]}`);
});

test('comment stripping preserves length and line numbers', () => {
  const source = 'const a = 1;\n// prose\nconst b = 2; /* block\nstill block */ const c = 3;\n';
  const blanked = blankJsComments(source);
  assert.equal(blanked.length, source.length);
  assert.equal(blanked.split('\n').length, source.split('\n').length);
  assert.ok(blanked.includes('const a = 1;'));
  assert.ok(blanked.includes('const c = 3;'));
  assert.ok(!blanked.includes('prose'));
  assert.ok(!blanked.includes('still block'));
});

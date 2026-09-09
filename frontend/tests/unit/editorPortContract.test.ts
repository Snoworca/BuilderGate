import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// FR-MDE-005 AC-1 / AC-6 / AC-7 — static contract over the ported editor tree.
// Every assertion below reads this repository only. The DocuLight checkout is a
// working copy on one machine, so a criterion that reads it cannot be run in CI.

const testDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(testDir, '../..');
const editorRoot = resolve(frontendRoot, 'src/editor');
const editorWindowPath = resolve(frontendRoot, 'src/components/editor/EditorWindow.tsx');
const packageJsonPath = resolve(frontendRoot, 'package.json');

const EDITOR_ROOT_MISSING = 'frontend/src/editor 가 존재하지 않는다';
const SCAN_ROOT_MISSING = '스캔 대상 디렉터리가 없어 실패한다';

const EXPECTED_SOURCE_FILE_COUNT = 25;
const EXPECTED_STYLE_FILES = [
  'styles/editor.css',
  'vendor/atomic-editor/styles/inline-preview.css',
];
const EXPECTED_PORTED_FILE_COUNT = EXPECTED_SOURCE_FILE_COUNT + EXPECTED_STYLE_FILES.length;
// 배럴을 뺀 합계다. 배럴은 이 저장소가 손대야 하는 유일한 이식 파일이라 이식
// 완전성의 척도가 될 수 없다 — AC-1 은 EditorWindow 가 배럴 하나만 경유하도록
// 재수출을 더하라고 요구하고, 그 추가가 곧 배럴의 줄 수를 바꾼다.
const EXPECTED_TOTAL_LINES = 7296;
const LICENSE_RELATIVE_PATH = 'vendor/atomic-editor/LICENSE';
const UPSTREAM_NOTE_RELATIVE_PATH = 'vendor/UPSTREAM.md';
// 이식 트리에 있으나 27파일 집계에 들지 않는 것들. 파일 수를 확장자와 무관한
// 두 번째 경로로 다시 세기 위한 목록이며, 여기 없는 파일은 전부 집계 대상이어야 한다.
const UNCOUNTED_FILES = [LICENSE_RELATIVE_PATH, UPSTREAM_NOTE_RELATIVE_PATH];
const BARREL_RELATIVE_PATH = 'index.ts';
const REACT_EDITOR_COMPONENT = 'AtomicCodeMirrorEditor';

const FORBIDDEN_COUPLING_TOKENS = ['fetch(', '/api/', 'localStorage', 'react-router'];
const CALLBACK_NAMES = [
  'onTagClick',
  'onAttach',
  'suggestWikiLinks',
  'onOpenWikiLink',
  'resolveWikiLink',
];

const REQUIRED_MERMAID_RANGE = '^11.4.1';
const REQUIRED_EXACT_DEPENDENCIES = ['katex', 'shiki'];
const REQUIRED_DEPENDENCY_SCOPES = ['@codemirror/', '@lezer/'];

function walkFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(absolute));
    } else if (entry.isFile()) {
      found.push(absolute);
    }
  }
  return found;
}

function toEditorRelative(absolute: string): string {
  return relative(editorRoot, absolute).split(sep).join('/');
}

function isInsideTestDirectory(relativePath: string): boolean {
  return relativePath.split('/').includes('__tests__');
}

// wc -l semantics: the number of newline characters. Every file of the recorded
// tree ends with a newline, so this equals the number of terminated lines and is
// identical under LF and CRLF.
function countNewlines(text: string): number {
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      total += 1;
    }
  }
  return total;
}

// 배럴에 허용되는 유일한 변경이 재수출 추가이므로(AC-1), 재수출 문과 주석과 공백을
// 걷어내고 남는 것이 있는지로 판정한다. 남으면 재수출이 아닌 코드가 들어온 것이다.
// export { … } from · export type { … } from · export * (as ns) from 을 모두 걷어낸다.
function stripReExportStatements(source: string): string {
  return source.replace(
    /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]\s*;?/g,
    '',
  );
}

function stripCommentsAndWhitespace(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
    .replace(/\s+/g, '');
}

function collectModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match = pattern.exec(source);
  while (match !== null) {
    specifiers.push(match[1]);
    match = pattern.exec(source);
  }
  return specifiers;
}

function resolveEditorTarget(specifier: string, fromDirectory: string): string | null {
  let absolute: string;
  if (specifier.startsWith('.')) {
    absolute = resolve(fromDirectory, specifier);
  } else if (specifier.includes('src/editor')) {
    absolute = resolve(frontendRoot, specifier.slice(specifier.indexOf('src/editor')));
  } else {
    return null;
  }
  if (absolute !== editorRoot && !absolute.startsWith(editorRoot + sep)) {
    return null;
  }
  return absolute.replace(/\.(ts|tsx|js|jsx)$/, '');
}

function isBarrelTarget(target: string): boolean {
  return target === editorRoot || target === join(editorRoot, 'index');
}

function readDeclaredDependencies(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return manifest.dependencies ?? {};
}

function describeDependencyGap(
  declaredMermaid: string | undefined,
  unmet: string[],
): string {
  const mermaidClause = declaredMermaid === undefined
    ? 'mermaid 선언이 없고'
    : `mermaid 가 ${declaredMermaid} 이고`;
  const restClause = unmet.length === 0
    ? '나머지 의존성은 모두 선언되어 있다'
    : `나머지 의존성이 없다 (미선언: ${unmet.join(', ')})`;
  return `${mermaidClause} ${restClause}`;
}

test('FR-MDE-005 ported tree holds 27 files, the MIT LICENSE and the entry barrel', () => {
  assert.ok(
    existsSync(editorRoot),
    `FR-MDE-005 AC-1: ${EDITOR_ROOT_MISSING} — 이식이 아직 수행되지 않았다`,
  );

  const portedFiles = walkFiles(editorRoot).map(toEditorRelative).sort();
  const sourceFiles = portedFiles.filter(
    (path) => /\.(ts|tsx)$/.test(path) && !isInsideTestDirectory(path),
  );
  const styleFiles = portedFiles.filter((path) => path.endsWith('.css'));

  assert.equal(
    sourceFiles.length,
    EXPECTED_SOURCE_FILE_COUNT,
    `FR-MDE-005 AC-1: __tests__ 밖의 .ts/.tsx 파일이 ${EXPECTED_SOURCE_FILE_COUNT}개여야 하는데 ${sourceFiles.length}개다 — ${sourceFiles.join(', ')}`,
  );
  assert.deepEqual(
    styleFiles,
    EXPECTED_STYLE_FILES,
    `FR-MDE-005 AC-1: CSS 파일은 ${EXPECTED_STYLE_FILES.join(' 과 ')} 둘뿐이어야 한다`,
  );

  const countedFiles = [...sourceFiles, ...styleFiles].sort();

  // 집계 대상을 두 번째 경로로 다시 센다. countedFiles 의 길이는 앞선 두 단언이
  // 통과하면 산술적으로 정해지므로 그 값만으로는 아무것도 잡지 못한다. 이쪽은 반대로
  // 집계에서 빠지는 것만 지목해 배제하므로 두 값의 출처가 갈린다 — 확장자 규칙이
  // 덮지 못하는 파일이 트리에 들어오면 그 자리에서 어긋난다.
  const countedByExclusion = portedFiles.filter(
    (path) => !isInsideTestDirectory(path) && !UNCOUNTED_FILES.includes(path),
  );
  assert.deepEqual(
    countedByExclusion,
    countedFiles,
    `FR-MDE-005 AC-1: 확장자로 고른 집계 대상과, 비집계 파일(${UNCOUNTED_FILES.join(' · ')})만 뺀 나머지가 같아야 한다`,
  );
  assert.equal(
    countedByExclusion.length,
    EXPECTED_PORTED_FILE_COUNT,
    `FR-MDE-005 AC-1: 집계 대상 파일이 ${EXPECTED_PORTED_FILE_COUNT}개여야 하는데 ${countedByExclusion.length}개다 — ${countedByExclusion.join(', ')}`,
  );

  // 파일 수에는 배럴이 그대로 들고, 줄 수 집계에서만 빠진다.
  const lineCountedFiles = countedFiles.filter((path) => path !== BARREL_RELATIVE_PATH);
  assert.equal(
    countedFiles.length - lineCountedFiles.length,
    1,
    `FR-MDE-005 AC-1: 줄 수 집계에서 빠지는 것은 배럴 ${BARREL_RELATIVE_PATH} 하나여야 한다`,
  );

  const totalLines = lineCountedFiles.reduce(
    (sum, path) => sum + countNewlines(readFileSync(resolve(editorRoot, path), 'utf8')),
    0,
  );
  assert.equal(
    totalLines,
    EXPECTED_TOTAL_LINES,
    `FR-MDE-005 AC-1: 배럴을 뺀 ${lineCountedFiles.length}파일의 줄 수 합계가 ${EXPECTED_TOTAL_LINES} 여야 하는데 ${totalLines} 다`,
  );

  const licensePath = resolve(editorRoot, LICENSE_RELATIVE_PATH);
  assert.ok(
    existsSync(licensePath),
    `FR-MDE-005 AC-1: MIT 고지 의무 파일 ${LICENSE_RELATIVE_PATH} 가 없다`,
  );
  const licenseText = readFileSync(licensePath, 'utf8');
  assert.match(
    licenseText,
    /MIT License/,
    `FR-MDE-005 AC-1: ${LICENSE_RELATIVE_PATH} 에 MIT 표제가 없다`,
  );
  assert.match(
    licenseText,
    /Permission is hereby granted, free of charge/,
    `FR-MDE-005 AC-1: ${LICENSE_RELATIVE_PATH} 에 MIT permission notice 가 없다`,
  );

  const barrelPath = resolve(editorRoot, BARREL_RELATIVE_PATH);
  assert.ok(
    existsSync(barrelPath),
    `FR-MDE-005 AC-1: 진입 배럴 ${BARREL_RELATIVE_PATH} 가 없다`,
  );
  const barrelSource = readFileSync(barrelPath, 'utf8');
  for (const exportedSymbol of ['doculightExtensions', REACT_EDITOR_COMPONENT]) {
    assert.match(
      barrelSource,
      new RegExp(`export\\s*\\{[^}]*\\b${exportedSymbol}\\b[^}]*\\}`),
      `FR-MDE-005 AC-1: 배럴이 ${exportedSymbol} 를 내보내지 않는다`,
    );
  }

  // 배럴만 줄 수 집계에서 빠지므로, 그 면제가 임의 코드의 통로가 되지 않게 여기서 막는다.
  // AC-1 이 배럴에 허용하는 변경은 재수출 추가뿐이다.
  const barrelResidue = stripCommentsAndWhitespace(stripReExportStatements(barrelSource));
  assert.equal(
    barrelResidue,
    '',
    `FR-MDE-005 AC-1: 배럴에 허용되는 변경은 재수출 추가뿐인데 그 밖의 코드가 있다 — ${barrelResidue.slice(0, 160)}`,
  );

  if (existsSync(editorWindowPath)) {
    const editorWindowSource = readFileSync(editorWindowPath, 'utf8');
    const bypassing = collectModuleSpecifiers(editorWindowSource).filter((specifier) => {
      const target = resolveEditorTarget(specifier, dirname(editorWindowPath));
      return target !== null && !isBarrelTarget(target);
    });
    assert.deepEqual(
      bypassing,
      [],
      `FR-MDE-005 AC-1: EditorWindow 가 배럴을 우회해 편집기 내부를 직접 import 한다 — ${bypassing.join(', ')}`,
    );
  }
});

test('FR-MDE-005 frontend package.json declares mermaid ^11.4.1, katex, shiki and the CodeMirror/Lezer packages', () => {
  const dependencies = readDeclaredDependencies();
  const declaredNames = Object.keys(dependencies);
  const declaredMermaid = dependencies.mermaid;

  const unmet: string[] = [];
  for (const name of REQUIRED_EXACT_DEPENDENCIES) {
    if (dependencies[name] === undefined) {
      unmet.push(name);
    }
  }
  for (const scope of REQUIRED_DEPENDENCY_SCOPES) {
    if (!declaredNames.some((name) => name.startsWith(scope))) {
      unmet.push(`${scope}*`);
    }
  }

  assert.ok(
    declaredMermaid === REQUIRED_MERMAID_RANGE && unmet.length === 0,
    `FR-MDE-005 AC-6: dependencies 가 mermaid ${REQUIRED_MERMAID_RANGE} · ${REQUIRED_EXACT_DEPENDENCIES.join(' · ')} · ${REQUIRED_DEPENDENCY_SCOPES.map((scope) => `${scope}*`).join(' · ')} 를 선언해야 하는데, ${describeDependencyGap(declaredMermaid, unmet)}`,
  );
});

test('FR-MDE-005 ported tree has zero coupling hits and a nonzero callback surface', () => {
  assert.ok(
    existsSync(editorRoot),
    `FR-MDE-005 AC-7: ${SCAN_ROOT_MISSING} — ${EDITOR_ROOT_MISSING}`,
  );

  const scanned = walkFiles(editorRoot).map((absolute) => ({
    path: toEditorRelative(absolute),
    text: readFileSync(absolute, 'utf8'),
  }));
  assert.ok(
    scanned.length > 0,
    `FR-MDE-005 AC-7: ${SCAN_ROOT_MISSING} — 이식된 파일이 하나도 없다`,
  );

  const couplingHits: string[] = [];
  for (const file of scanned) {
    const lines = file.text.split('\n');
    lines.forEach((line, index) => {
      for (const token of FORBIDDEN_COUPLING_TOKENS) {
        if (line.includes(token)) {
          couplingHits.push(`${file.path}:${index + 1} ${token}`);
        }
      }
    });
  }
  assert.deepEqual(
    couplingHits,
    [],
    `FR-MDE-005 AC-7: 편집기는 호스트에 결합되지 않아야 하는데 ${FORBIDDEN_COUPLING_TOKENS.join(' · ')} 가 발견됐다`,
  );

  for (const callback of CALLBACK_NAMES) {
    const hits = scanned.filter((file) => file.text.includes(callback)).length;
    assert.ok(
      hits > 0,
      `FR-MDE-005 AC-7: doculightExtensions 콜백 ${callback} 가 이식된 트리에 없다`,
    );
  }
});

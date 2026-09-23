// IR-FOP-002 AC-1~4, AC-7: 서버와 프런트엔드가 각자 들고 있는 ws-protocol.ts 사본이 file-job 메시지 세 종을
// 같은 모양으로 선언하는지 소스 텍스트로 대조한다.
//
// 왜 소스 텍스트인가: 두 사본은 서로 다른 tsconfig 에 속해 있어 한쪽의 타입을 다른 쪽에서 import 해 비교할 수
// 없다. 타입은 런타임에 사라지므로 남는 것은 선언 텍스트뿐이다. 그래서 이 파일은 src/ 에서만 돈다 —
// dist/ 에는 .ts 원본이 복사되지 않는다.
//
// 왜 주석을 걷어내고, 왜 스캐너가 문자열을 건너뛰는가: 주석 속에 적힌 "type: 'file-job:progress'" 같은 산문이
// 단언을 대신 만족시키는 일이 이 저장소에서 실제로 있었다. 반대로 문자열 리터럴 타입 안의 '//' 나 '/*' 를
// 주석 시작으로 읽으면 선언을 먹어 버린다. 둘 다 막으려면 문자열과 주석을 함께 아는 스캐너가 필요하다.
//
// 기대 필드에 sessionId 가 들어가는 이유: 관리자는 broadcastWs(sessionId, event, payload) 로 보내고
// WsRouter.sendSessionEvent 가 { type, sessionId, ...payload } 로 싼다. 선 위의 메시지에는 sessionId 가 붙으며,
// 두 사본의 기존 세션 이벤트('cwd', 'session:exited')도 같은 방식으로 sessionId 를 선언한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SERVER_URL = new URL('./ws-protocol.ts', import.meta.url);
const FRONTEND_URL = new URL('../../../frontend/src/types/ws-protocol.ts', import.meta.url);

const UNION_START = 'export type ServerWsMessage =';
const UNION_END = 'export interface SubscribedSessionInfo';

const FILE_JOB_TYPES = ['file-job:progress', 'file-job:decision-required', 'file-job:done'] as const;
type FileJobType = (typeof FILE_JOB_TYPES)[number];

// 관리자(fileJobManager)가 실제로 싣는 페이로드 + 라우터가 붙이는 type·sessionId.
const EXPECTED_FIELDS: Record<FileJobType, readonly string[]> = {
  'file-job:progress': [
    'type', 'sessionId', 'jobId', 'phase', 'processedBytes', 'totalBytes',
    'processedEntries', 'totalEntries', 'currentPath',
  ],
  'file-job:decision-required': ['type', 'sessionId', 'jobId', 'decisionId', 'kind', 'path', 'detail', 'choices'],
  'file-job:done': ['type', 'sessionId', 'jobId', 'outcome', 'processedEntries', 'affectedDirectories'],
};

interface FieldDecl {
  optional: boolean;
  typeText: string;
}
type FieldMap = Map<string, FieldDecl>;

/** 주석만 공백으로 바꾸고 문자열·템플릿 리터럴은 그대로 둔다. 줄바꿈은 보존한다. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      const start = i;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 문자열 밖에서 괄호 깊이를 추적하며 depth 0 의 분리자 위치로 자른다. '=>' 의 '>' 는 깊이에 세지 않는다. */
function splitTopLevel(text: string, isSeparator: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\'' || c === '"' || c === '`') {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
    else if (c === '}' || c === ')' || c === ']' || (c === '>' && text[i - 1] !== '=')) depth--;
    else if (depth === 0 && isSeparator(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** open 이 '{' 를 가리킬 때 짝이 맞는 '}' 까지의 안쪽 텍스트. 문자열 안의 괄호는 세지 않는다. */
function balancedBody(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\'' || c === '"' || c === '`') {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

const PROPERTY_HEAD = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:/;

function parseFields(body: string): FieldMap {
  // 세미콜론·쉼표·줄바꿈 어느 것으로도 속성을 가를 수 있다. 여러 줄에 걸친 속성 타입은
  // 속성 머리로 시작하지 않는 조각을 앞 조각에 붙여 되살린다.
  const raw = splitTopLevel(body, ch => ch === ';' || ch === ',' || ch === '\n');
  const segments: string[] = [];
  for (const piece of raw) {
    if (piece.trim() === '') continue;
    if (PROPERTY_HEAD.test(piece) || segments.length === 0) segments.push(piece);
    else segments[segments.length - 1] += ` ${piece}`;
  }
  const fields: FieldMap = new Map();
  for (const segment of segments) {
    const m = PROPERTY_HEAD.exec(segment);
    if (!m) continue;
    const typeText = segment.slice(m[0].length).replace(/\s+/g, ' ').trim();
    fields.set(m[1], { optional: m[2] === '?', typeText });
  }
  return fields;
}

/**
 * 타입 식을 필드 맵으로 푼다. 인라인 객체, 같은 파일의 interface(extends 포함)·type 별칭, 그리고 그것들의
 * 교차(&)를 푼다 — 두 사본이 이미 공통 식별 필드를 extends·& 로 나눠 쓰고 있어 green 도 그렇게 쓸 수 있다.
 * Omit<> 같은 제네릭은 풀지 않고 null 을 돌려준다(그 arm 은 missing 으로 보고된다 — 공허한 통과보다 낫다).
 */
function resolveTypeExpr(expr: string, fullStripped: string, seen: Set<string>): FieldMap | null {
  const merged: FieldMap = new Map();
  for (const part of splitTopLevel(expr, ch => ch === '&')) {
    const trimmed = part.trim();
    let fields: FieldMap | null = null;
    if (trimmed.startsWith('{')) {
      const body = balancedBody(trimmed, 0);
      fields = body === null ? null : parseFields(body);
    } else if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      fields = resolveNamedType(fullStripped, trimmed, seen);
    }
    if (!fields) return null;
    for (const [name, decl] of fields) merged.set(name, decl);
  }
  return merged;
}

function resolveNamedType(fullStripped: string, name: string, seen: Set<string>): FieldMap | null {
  if (seen.has(name)) return null;
  const next = new Set(seen).add(name);
  const escaped = name.replace(/[$]/g, '\\$');
  const iface = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?interface\\s+${escaped}\\s*(?:extends\\s+([^{]+))?\\{`).exec(fullStripped);
  if (iface) {
    const body = balancedBody(fullStripped, iface.index + iface[0].length - 1);
    if (body === null) return null;
    const merged: FieldMap = new Map();
    for (const parent of iface[1] ? splitTopLevel(iface[1], ch => ch === ',') : []) {
      const parentFields = resolveTypeExpr(parent, fullStripped, next);
      if (!parentFields) return null;
      for (const [field, decl] of parentFields) merged.set(field, decl);
    }
    for (const [field, decl] of parseFields(body)) merged.set(field, decl);
    return merged;
  }
  const alias = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?type\\s+${escaped}\\s*=`).exec(fullStripped);
  if (!alias) return null;
  const rest = fullStripped.slice(alias.index + alias[0].length);
  return resolveTypeExpr(splitTopLevel(rest, ch => ch === ';')[0], fullStripped, next);
}

/** 한 사본에서 ServerWsMessage 유니온의 file-job arm 을 type 문자열 → 필드 맵으로 모은다. */
function extractFileJobArms(source: string, label: string): Map<string, FieldMap> {
  const stripped = stripComments(source);
  const start = stripped.indexOf(UNION_START);
  const end = stripped.indexOf(UNION_END, start + 1);
  assert.ok(start !== -1, `${label}: '${UNION_START}' not found`);
  assert.ok(end !== -1, `${label}: '${UNION_END}' not found after the union`);
  const unionText = stripped.slice(start + UNION_START.length, end).replace(/;\s*$/, '');
  const arms = new Map<string, FieldMap>();
  for (const armText of splitTopLevel(unionText, ch => ch === '|')) {
    const trimmed = armText.trim();
    if (trimmed === '') continue;
    const fields = resolveTypeExpr(trimmed, stripped, new Set());
    const typeField = fields?.get('type');
    const literal = typeField && /^'([^']*)'$/.exec(typeField.typeText);
    if (fields && literal && literal[1].startsWith('file-job:')) arms.set(literal[1], fields);
  }
  return arms;
}

/** 'a' | 'b' 형태의 타입 텍스트에서 문자열 리터럴 집합을 얻는다. 리터럴이 아닌 항이 있으면 null. */
function literalSet(typeText: string): Set<string> | null {
  const members = splitTopLevel(typeText, ch => ch === '|').map(s => s.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const member of members) {
    const m = /^'([^']*)'$/.exec(member);
    if (!m) return null;
    out.add(m[1]);
  }
  return out;
}

/**
 * 두 사본의 file-job 선언 차이를 사람이 읽을 문장 목록으로 돌려준다. 빈 목록이면 일치다.
 * 한쪽이나 양쪽에 arm 이 없는 것도 차이로 센다 — 그러지 않으면 둘 다 비어 있을 때 공허하게 일치한다.
 */
function diffFileJobDeclarations(
  a: { label: string; source: string },
  b: { label: string; source: string },
): string[] {
  const armsA = extractFileJobArms(a.source, a.label);
  const armsB = extractFileJobArms(b.source, b.label);
  const diffs: string[] = [];
  for (const type of FILE_JOB_TYPES) {
    const fa = armsA.get(type);
    const fb = armsB.get(type);
    if (!fa) diffs.push(`missing arm ${type} in ${a.label}`);
    if (!fb) diffs.push(`missing arm ${type} in ${b.label}`);
    if (!fa || !fb) continue;
    for (const [name, decl] of fa) {
      const other = fb.get(name);
      if (!other) diffs.push(`${type}: field '${name}' only in ${a.label}`);
      else if (other.optional !== decl.optional) diffs.push(`${type}: field '${name}' optionality differs`);
    }
    for (const name of fb.keys()) {
      if (!fa.has(name)) diffs.push(`${type}: field '${name}' only in ${b.label}`);
    }
  }
  return diffs;
}

const COPIES = [
  { label: 'server', source: readFileSync(SERVER_URL, 'utf8') },
  { label: 'frontend', source: readFileSync(FRONTEND_URL, 'utf8') },
] as const;

function requireArm(copy: { label: string; source: string }, type: FileJobType): FieldMap {
  const arm = extractFileJobArms(copy.source, copy.label).get(type);
  assert.ok(arm, `missing arm ${type} in ${copy.label} ServerWsMessage`);
  return arm;
}

function assertFieldNames(copy: { label: string; source: string }, type: FileJobType): FieldMap {
  const arm = requireArm(copy, type);
  const expected = new Set(EXPECTED_FIELDS[type]);
  const missing = [...expected].filter(name => !arm.has(name));
  const extra = [...arm.keys()].filter(name => !expected.has(name));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${copy.label} ${type}: missing fields [${missing.join(', ')}], unexpected fields [${extra.join(', ')}]`,
  );
  return arm;
}

function assertLiteralField(arm: FieldMap, label: string, type: FileJobType, field: string, expected: string[]): void {
  const decl = arm.get(field);
  assert.ok(decl, `${label} ${type}: field '${field}' missing`);
  const actual = literalSet(decl.typeText);
  assert.ok(actual, `${label} ${type}: field '${field}' must be a string-literal union, got '${decl.typeText}'`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} ${type}: field '${field}' literals`);
}

// @req IR-FOP-002 AC-1
test('서버 ServerWsMessage 유니온이 file-job:progress·file-job:decision-required·file-job:done 세 type 을 포함한다', () => {
  const server = COPIES[0];
  const arms = extractFileJobArms(server.source, server.label);
  const missing = FILE_JOB_TYPES.filter(type => !arms.has(type));
  assert.deepEqual(missing, [], `missing arm ${missing.join(', ')} in server ServerWsMessage`);
});

// @req IR-FOP-002 AC-2
test('file-job:progress 선언 필드가 jobId·phase·processedBytes·totalBytes·processedEntries·totalEntries·currentPath 다', () => {
  for (const copy of COPIES) {
    const arm = assertFieldNames(copy, 'file-job:progress');
    // 러너(fileJobRunner 의 FileJobProgress)가 내는 두 단계다. string 으로 느슨하게 선언하면 받는 쪽이 단계를 가릴 수 없다.
    assertLiteralField(arm, copy.label, 'file-job:progress', 'phase', ['scanning', 'transferring']);
  }
});

// @req IR-FOP-002 AC-3
test('file-job:decision-required 선언 필드가 jobId·decisionId·kind·path·detail·choices 이고 kind 가 conflict|error 다', () => {
  for (const copy of COPIES) {
    const arm = assertFieldNames(copy, 'file-job:decision-required');
    assertLiteralField(arm, copy.label, 'file-job:decision-required', 'kind', ['conflict', 'error']);
  }
});

// @req IR-FOP-002 AC-4
test('file-job:done 선언 필드가 jobId·outcome·processedEntries·affectedDirectories 이고 outcome 이 completed|cancelled|failed 다', () => {
  for (const copy of COPIES) {
    const arm = assertFieldNames(copy, 'file-job:done');
    assertLiteralField(arm, copy.label, 'file-job:done', 'outcome', ['completed', 'cancelled', 'failed']);
  }
});

// @req IR-FOP-002 AC-7
test('서버·프런트엔드 두 사본의 file-job 메시지 세 종이 같은 type 문자열과 같은 필드 이름 집합을 갖는다 (주석 제거 후 비교)', () => {
  const diffs = diffFileJobDeclarations(COPIES[0], COPIES[1]);
  assert.deepEqual(diffs, [], `ws-protocol copies disagree:\n  ${diffs.join('\n  ')}`);
});

// 아래 fixture 는 대조 함수 자체를 시험한다 — 위 다섯 case 가 공허하게 통과할 수 없음을 보이기 위해서다.
function fixture(arms: string, extraDecls = ''): string {
  return [
    extraDecls,
    UNION_START,
    "  | { type: 'cwd'; sessionId: string; cwd: string }",
    arms,
    "  | { type: 'pong' };",
    '',
    `${UNION_END} {`,
    '  id: string;',
    '}',
  ].join('\n');
}

const BASE_ARMS = [
  "  | { type: 'file-job:progress'; sessionId: string; jobId: string; phase: 'scanning' | 'transferring';",
  '      processedBytes: number; totalBytes: number; processedEntries: number; totalEntries: number;',
  '      currentPath: string | null }',
  '  | {',
  "      type: 'file-job:decision-required';",
  '      sessionId: string;',
  '      jobId: string;',
  '      decisionId: string;',
  "      kind: 'conflict' | 'error';",
  '      path: string;',
  '      detail: string | null;',
  "      choices: Array<'overwrite' | 'rename' | 'skip'>;",
  '    }',
  '  | FileJobDoneMessage',
].join('\n');

const DONE_DECL = [
  'export interface FileJobDoneMessage {',
  "  type: 'file-job:done';",
  '  sessionId: string;',
  '  jobId: string;',
  "  outcome: 'completed' | 'cancelled' | 'failed';",
  '  processedEntries: number;',
  '  affectedDirectories: string[];',
  '}',
].join('\n');

// @req IR-FOP-002 AC-7
test('한쪽 사본에만 필드를 더한 변이 입력에서 대조 함수가 실패한다', () => {
  const a = { label: 'A', source: fixture(BASE_ARMS, DONE_DECL) };

  // 대조군: 같은 선언이면 차이가 없다 — 스캐너가 인라인 arm 과 이름으로 가리킨 arm 을 모두 찾는다는 뜻이다.
  assert.deepEqual(diffFileJobDeclarations(a, { label: 'B', source: fixture(BASE_ARMS, DONE_DECL) }), []);

  // 한쪽에만 필드를 더하면 그 필드 이름이 차이에 나온다.
  const addedField = BASE_ARMS.replace('decisionId: string;', 'decisionId: string;\n      retryable: boolean;');
  assert.deepEqual(
    diffFileJobDeclarations(a, { label: 'B', source: fixture(addedField, DONE_DECL) }),
    ["file-job:decision-required: field 'retryable' only in B"],
  );

  // 이름으로 가리킨 arm 쪽에서 필드를 빼도 잡힌다.
  const droppedDone = DONE_DECL.replace('  affectedDirectories: string[];\n', '');
  assert.deepEqual(
    diffFileJobDeclarations(a, { label: 'B', source: fixture(BASE_ARMS, droppedDone) }),
    ["file-job:done: field 'affectedDirectories' only in A"],
  );

  // 주석 속 필드는 필드가 아니다.
  const commentedField = BASE_ARMS.replace('jobId: string;\n      decisionId', 'jobId: string;\n      // retryable: boolean;\n      /* extra: string; */ decisionId');
  assert.deepEqual(diffFileJobDeclarations(a, { label: 'B', source: fixture(commentedField, DONE_DECL) }), []);

  // 주석이나 문자열 속의 type 문자열은 arm 이 아니다 — 둘 다 비어도 '일치' 가 아니라 missing 이다.
  const proseOnly = fixture("  // | { type: 'file-job:progress'; sessionId: string }\n  | { type: 'note'; text: 'file-job:done' }");
  const proseDiffs = diffFileJobDeclarations({ label: 'A', source: proseOnly }, { label: 'B', source: proseOnly });
  for (const type of FILE_JOB_TYPES) {
    assert.ok(proseDiffs.includes(`missing arm ${type} in A`), `expected missing arm ${type} in A, got ${JSON.stringify(proseDiffs)}`);
  }

  // 문자열 리터럴 타입 안의 '//' 와 '/*' 는 주석 시작이 아니다 — 뒤따르는 필드를 먹지 않는다.
  const tricky = BASE_ARMS.replace("phase: 'scanning' | 'transferring';", "phase: 'scanning//x' | 'transferring/*y';");
  assert.deepEqual(diffFileJobDeclarations(a, { label: 'B', source: fixture(tricky, DONE_DECL) }), []);

  // 공통 식별 필드를 extends 나 & 로 나눠 선언해도 같은 필드 집합으로 푼다 — 그리고 부모에서 빠진 필드도 잡힌다.
  const identity = "export interface FileJobIdentity {\n  sessionId: string;\n  jobId: string;\n}\n";
  const doneBody = "  type: 'file-job:done';\n  outcome: 'completed' | 'cancelled' | 'failed';\n  processedEntries: number;\n  affectedDirectories: string[];\n";
  const viaExtends = `${identity}export interface FileJobDoneMessage extends FileJobIdentity {\n${doneBody}}`;
  const viaIntersection = `${identity}export type FileJobDoneMessage = FileJobIdentity & {\n${doneBody}};`;
  assert.deepEqual(diffFileJobDeclarations(a, { label: 'B', source: fixture(BASE_ARMS, viaExtends) }), []);
  assert.deepEqual(diffFileJobDeclarations(a, { label: 'B', source: fixture(BASE_ARMS, viaIntersection) }), []);
  assert.deepEqual(
    diffFileJobDeclarations(a, { label: 'B', source: fixture(BASE_ARMS, viaExtends.replace('  jobId: string;\n', '')) }),
    ["file-job:done: field 'jobId' only in A"],
  );

  // 선택성 차이도 잡힌다.
  const optionalPath = BASE_ARMS.replace('      path: string;', '      path?: string;');
  assert.deepEqual(
    diffFileJobDeclarations(a, { label: 'B', source: fixture(optionalPath, DONE_DECL) }),
    ["file-job:decision-required: field 'path' optionality differs"],
  );
});

// FR-FOP-003 · IR-FOP-001 · SEC-FOP-001 — 서버 배선 계약 가드.
//
// index.ts 는 부트스트랩을 export 하지 않는다(모듈 최상위에서 config 를 읽고 서버를 띄운다).
// 그래서 "작업 관리자가 실제 서버에 어떻게 꽂혀 있는가" 는 소스 텍스트로만 실행 가능하게 볼 수
// 있다. 여기서 보는 배선이 빠지면 단위 테스트는 전부 green 인 채로 운영에서 기능이 없다.
//
// 계약(T-PH003-08 이 이 형태로 구현한다):
//   const <policy> = { getCwd…, blockedPaths… }                       — 정책 객체는 하나
//   const <mgr> = new FileJobManager({
//     broadcast: … sessionManager.broadcastWs …,
//     validatePathFor: (sid) => (p) => validateCreatePath(<policy>, sid, p), … })
//   createSessionRoutes({ onSessionDeleting: …, onSessionDeleted: (id) => <mgr>.cancelSessionJobs(id) })
//   app.use('/api/file-jobs', authMiddleware, createFileJobRoutes(<mgr>, <policy>))
//     (또는 fileRoutes 처럼 변수에 담아 app.use(…, authMiddleware, <var>))
//   fileJobRoutes.ts: 출발지·목적지 모두 validateCreatePath, GET 이 resendPendingDecisions.
//
// 소스는 주석을 걷고 문자열 리터럴을 자리표시자로 바꾼 뒤 본다. 주석이나 문자열 안의 토큰이
// 단언을 대신 만족시킨 적이 이 저장소에 있다 — 그 경로를 구조적으로 닫는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

interface Masked {
  /** 주석 제거, 모든 문자열·템플릿 리터럴은 "S<n>" 로 치환된 소스 */
  code: string;
  /** S<n> → 리터럴 내용(따옴표 제외, 이스케이프 원문 그대로) */
  literals: string[];
}

// 문자열·템플릿 리터럴을 건너뛰며 주석을 걷는다. 정규식 한 줄로 하면 같은 줄 앞쪽 문자열 안의
// '//' 에서 줄 끝까지 지워져 그 뒤의 실제 호출이 빠진다. 리터럴은 내용을 표에 옮기고 자리표시자로
// 바꿔, 괄호 균형 계산과 토큰 검색이 문자열 내용에 흔들리지 않게 한다.
function mask(source: string): Masked {
  const literals: string[] = [];
  let code = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const start = i + 1;
      i += 1;
      while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
      literals.push(source.slice(start, i));
      i += 1;
      code += `"S${literals.length - 1}"`;
    } else {
      code += ch;
      i += 1;
    }
  }
  return { code, literals };
}

const OPEN: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

/** text[openIdx] 의 여는 괄호에 짝지어진 닫는 괄호 위치. 못 찾으면 -1. */
function matchClose(text: string, openIdx: number): number {
  const stack: string[] = [];
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** 깊이 0 의 쉼표로 나눈다(각 조각은 trim). */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (OPEN[c]) depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/** calleePattern(끝이 '(' 직전) 으로 시작하는 모든 호출의 인자 목록. */
function callsOf(code: string, calleePattern: RegExp): string[][] {
  const re = new RegExp(`${calleePattern.source}\\s*\\(`, 'g');
  const out: string[][] = [];
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(code, open);
    if (close === -1) continue;
    out.push(splitTopLevel(code.slice(open + 1, close)));
  }
  return out;
}

/** `const|let name(: T)? = <expr>` 의 초기화 식. 객체/호출이면 균형 괄호까지 포함. */
function initializerOf(code: string, name: string): string | undefined {
  const re = new RegExp(`\\b(?:const|let)\\s+${name}\\b(?:\\s*:\\s*[\\w.<>\\[\\]]+)?\\s*=\\s*`);
  const m = re.exec(code);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const firstBracket = code.slice(start).search(/[({[;]/);
  if (firstBracket === -1) return undefined;
  const openIdx = start + firstBracket;
  if (code[openIdx] === ';') return code.slice(start, openIdx).trim();
  const close = matchClose(code, openIdx);
  return close === -1 ? undefined : code.slice(start, close + 1).trim();
}

/** 객체 리터럴 텍스트에서 key 항목의 값(메서드 축약형이면 항목 전체, 축약 속성이면 key). */
function propertyOf(objText: string, key: string): string | undefined {
  const t = objText.trim();
  if (!t.startsWith('{')) return undefined;
  const close = matchClose(t, 0);
  if (close === -1) return undefined;
  for (const entry of splitTopLevel(t.slice(1, close))) {
    const kv = new RegExp(`^${key}\\s*:\\s*`).exec(entry);
    if (kv) return entry.slice(kv[0].length);
    if (new RegExp(`^(?:async\\s+)?${key}\\s*\\(`).test(entry)) return entry;
    if (entry === key) return key;
  }
  return undefined;
}

/** 인자가 식별자면 그 초기화 식으로 풀어 준다(한 단계). */
function resolveObject(code: string, arg: string): string | undefined {
  if (arg.startsWith('{')) return arg;
  if (/^\w+$/.test(arg)) return initializerOf(code, arg);
  return undefined;
}

/** 화살표·function 식의 첫 매개변수 이름. */
function firstParam(fn: string): string | undefined {
  const m = /^(?:async\s+)?(?:function\s*\w*\s*)?\(?\s*(\w+)/.exec(fn.trim());
  return m?.[1];
}

async function loadMasked(rel: string): Promise<Masked> {
  return mask(await readFile(new URL(rel, import.meta.url), 'utf8'));
}

const INDEX = '../../index.ts';
const ROUTES = '../../routes/fileJobRoutes.ts';

// 스캐너 자기 점검. 이것이 틀리면 아래 모든 단언이 아무것도 보지 않은 채 통과·실패한다.
function assertMaskSound(): void {
  const probe = mask('const a = "x // y"; use(a); // cancelSessionJobs(b)\n/* broadcastWs() */ ok(\'/api/file-jobs\');');
  assert.match(probe.code, /use\(a\)/, `mask 가 문자열 뒤 코드를 지웠다: ${probe.code}`);
  assert.doesNotMatch(probe.code, /cancelSessionJobs|broadcastWs/, `mask 가 주석을 남겼다: ${probe.code}`);
  assert.doesNotMatch(probe.code, /api\/file-jobs/, `mask 가 문자열 내용을 코드에 남겼다: ${probe.code}`);
  assert.deepEqual(probe.literals, ['x // y', '/api/file-jobs']);
}

// 양성 대조: 실제 index.ts 에서 이미 있는 fileRoutes 마운트를 이 도구로 찾을 수 있어야 한다.
// 못 찾으면 도구가 index.ts 를 잘못 읽고 있는 것이고, 그때의 red 는 배선 부재를 말하지 않는다.
function assertFileRoutesMountVisible(idx: Masked): void {
  const mounts = callsOf(idx.code, /\bapp\.use/).filter(
    (a) => a.length === 3 && literalOf(idx, a[0]) === '/api/sessions' && a[1] === 'authMiddleware' && a[2] === 'fileRoutes',
  );
  assert.equal(mounts.length, 1, '양성 대조 실패: 기존 fileRoutes 마운트를 찾지 못했다 — 스캐너가 index.ts 를 잘못 읽는다');
  assert.equal(initializerOf(idx.code, 'fileRoutes'), 'createFileRoutes(fileService)', '양성 대조 실패: fileRoutes 초기화 식');
  assert.match(idx.code, /\bconst\s+authMiddleware\s*=\s*createAuthMiddleware\s*\(/, '양성 대조 실패: authMiddleware 정의');
}

function literalOf(m: Masked, token: string): string | undefined {
  const r = /^"S(\d+)"$/.exec(token.trim());
  return r ? m.literals[Number(r[1])] : undefined;
}

/** new FileJobManager(...) 가 대입된 변수 이름과 deps 객체 텍스트. */
function managerOf(idx: Masked): { name: string; deps: string } {
  const m = /\b(?:const|let)\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*new\s+FileJobManager\s*\(/.exec(idx.code);
  assert.ok(m, 'index.ts 에 `const <이름> = new FileJobManager(…)` 가 없다 — 작업 관리자가 서버에 만들어지지 않는다');
  const open = m.index + m[0].length - 1;
  const close = matchClose(idx.code, open);
  const args = splitTopLevel(idx.code.slice(open + 1, close));
  assert.equal(args.length, 1, `new FileJobManager 인자 수 ${args.length} — deps 객체 하나여야 한다`);
  const deps = resolveObject(idx.code, args[0]);
  assert.ok(deps, `new FileJobManager 의 인자 ${args[0]} 를 객체 리터럴로 풀 수 없다`);
  return { name: m[1], deps };
}

/** createFileJobRoutes(<mgr>, <policy>) 호출 인자. 정확히 하나여야 한다. */
function routesCallOf(idx: Masked): string[] {
  const calls = callsOf(idx.code, /\bcreateFileJobRoutes/);
  assert.equal(calls.length, 1, `index.ts 의 createFileJobRoutes 호출 ${calls.length}건 — 정확히 1건이어야 한다`);
  assert.equal(calls[0].length, 2, 'createFileJobRoutes 는 (manager, pathPolicy) 두 인자를 받는다');
  return calls[0];
}

test('mask 스캐너 자기 점검과 index.ts 양성 대조', async () => {
  assertMaskSound();
  assertFileRoutesMountVisible(await loadMasked(INDEX));
});

// @req IR-FOP-001 AC-1
test('index.ts 가 /api/file-jobs 를 authMiddleware 뒤에 마운트한다', async () => {
  const idx = await loadMasked(INDEX);
  assertFileRoutesMountVisible(idx);

  const importFrom = [...idx.code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*("S\d+")/g)].find((m) =>
    /\bcreateFileJobRoutes\b/.test(m[1]),
  );
  assert.ok(importFrom, 'index.ts 가 createFileJobRoutes 를 import 하지 않는다');
  assert.equal(literalOf(idx, importFrom[2]), './routes/fileJobRoutes.js');

  const mounts = callsOf(idx.code, /\bapp\.use/).filter((a) => literalOf(idx, a[0]) === '/api/file-jobs');
  assert.equal(mounts.length, 1, `'/api/file-jobs' 마운트 ${mounts.length}건 — 정확히 1건이어야 한다`);
  const [, auth, router] = mounts[0];
  assert.equal(mounts[0].length, 3, `마운트 인자 ${mounts[0].join(', ')} — (경로, authMiddleware, 라우터) 여야 한다`);
  assert.equal(auth, 'authMiddleware', `두 번째 인자 ${auth} — 인증 없이 파일 작업이 열린다`);
  const routerExpr = /^\w+$/.test(router) ? initializerOf(idx.code, router) : router;
  assert.match(routerExpr ?? '', /^createFileJobRoutes\s*\(/, `라우터 ${router} 가 createFileJobRoutes(…) 가 아니다`);
});

// @req FR-FOP-003 AC-1
test('index.ts 가 onSessionDeleted 에서 그 세션의 작업을 정리한다 — 작업 수명이 연결이 아니라 세션에 매인다', async () => {
  const idx = await loadMasked(INDEX);
  const calls = callsOf(idx.code, /\bcreateSessionRoutes/);
  assert.equal(calls.length, 1, `createSessionRoutes 호출 ${calls.length}건`);
  const opts = resolveObject(idx.code, calls[0][0] ?? '');
  assert.ok(opts, 'createSessionRoutes 옵션을 객체로 풀 수 없다');

  // 경계: 기존 onSessionDeleting 배선은 그대로 남아야 한다.
  assert.match(propertyOf(opts, 'onSessionDeleting') ?? '', /workspaceService\.markSessionStoppedByDirectDelete\s*\(/,
    '기존 onSessionDeleting → markSessionStoppedByDirectDelete 배선이 사라졌다');

  const deleted = propertyOf(opts, 'onSessionDeleted');
  assert.ok(deleted, 'createSessionRoutes 옵션에 onSessionDeleted 가 없다 — 세션이 지워져도 그 작업이 계속 돈다');
  const { name } = managerOf(idx);
  const param = firstParam(deleted);
  assert.ok(param, `onSessionDeleted 값 ${deleted} 에서 세션 id 매개변수를 읽을 수 없다`);
  assert.match(deleted, new RegExp(`\\b${name}\\s*(?:\\?\\.|\\.)\\s*cancelSessionJobs\\s*\\(\\s*${param}\\s*[,)]`),
    `onSessionDeleted 가 ${name}.cancelSessionJobs(${param}) 를 부르지 않는다: ${deleted}`);
});

// @req FR-FOP-003 AC-3
test('fileJobRoutes.ts 의 GET 핸들러가 manager.resendPendingDecisions 를 부르고, index.ts 가 매니저 broadcast 로 sessionManager.broadcastWs 를 넘긴다', async () => {
  const routes = await loadMasked(ROUTES);
  const gets = callsOf(routes.code, /\brouter\.get/).filter((a) => literalOf(routes, a[0]) === '/');
  assert.equal(gets.length, 1, `GET '/' 핸들러 ${gets.length}건`);
  assert.match(gets[0].slice(1).join(','), /\bmanager\.resendPendingDecisions\s*\(/,
    'GET 핸들러가 manager.resendPendingDecisions 를 부르지 않는다 — 재접속한 쪽이 대기 질문을 놓친다');

  const idx = await loadMasked(INDEX);
  const { deps } = managerOf(idx);
  const broadcast = propertyOf(deps, 'broadcast');
  assert.ok(broadcast, 'FileJobManager deps 에 broadcast 가 없다');
  assert.match(broadcast, /\bsessionManager\.broadcastWs\b/,
    `broadcast 가 sessionManager.broadcastWs 로 보내지 않는다: ${broadcast}`);
});

// @req SEC-FOP-001 AC-2
test('라우터의 pathPolicy 와 관리자의 validatePathFor 가 한 정책 객체(같은 getCwd·blockedPaths)에서 온다', async () => {
  const idx = await loadMasked(INDEX);
  const { name: mgr, deps } = managerOf(idx);
  const [mgrArg, policyArg] = routesCallOf(idx);
  assert.equal(mgrArg, mgr, `createFileJobRoutes 첫 인자 ${mgrArg} 가 만든 관리자 ${mgr} 가 아니다`);
  assert.match(policyArg, /^\w+$/, `pathPolicy 인자 ${policyArg} 가 이름 붙은 정책 객체가 아니다 — 인라인이면 관리자와 공유될 수 없다`);

  const policy = initializerOf(idx.code, policyArg);
  assert.ok(policy, `정책 ${policyArg} 의 정의를 찾을 수 없다`);
  assert.ok(propertyOf(policy, 'getCwd'), `정책 ${policyArg} 에 getCwd 가 없다`);
  assert.ok(propertyOf(policy, 'blockedPaths'), `정책 ${policyArg} 에 blockedPaths 가 없다`);

  const vpf = propertyOf(deps, 'validatePathFor');
  assert.ok(vpf, 'FileJobManager deps 에 validatePathFor 가 없다');
  const sid = firstParam(vpf);
  assert.ok(sid, `validatePathFor 값 ${vpf} 에서 세션 id 매개변수를 읽을 수 없다`);
  assert.match(vpf, new RegExp(`\\bvalidate\\w*Path\\s*\\(\\s*${policyArg}\\s*,\\s*${sid}\\s*,`),
    `validatePathFor 가 라우터와 같은 정책 ${policyArg} 로 검증하지 않는다: ${vpf}`);

  // 한 출처: 경로 검증 호출은 전부 그 정책 하나를 쓴다. 두 번째 정책 객체가 생기면 한쪽만 고쳐진다.
  for (const args of callsOf(idx.code, /\bvalidate(?:Create|Session)Path/)) {
    assert.equal(args[0], policyArg, `경로 검증이 다른 정책 ${args[0]} 을 쓴다 — 출처가 둘이다`);
  }
});

// @req SEC-FOP-001 AC-1
test('운영 배선에서 출발지·목적지 검증 모두 validateCreatePath 를 쓴다 — validateSessionPath 는 원시 cwd 와 비교해 링크·8.3 cwd 안의 링크를 잘못 거부한다', async () => {
  const routes = await loadMasked(ROUTES);
  const routeCreate = callsOf(routes.code, /\bvalidateCreatePath/);
  assert.equal(callsOf(routes.code, /\bvalidateSessionPath/).length, 0,
    'fileJobRoutes.ts 가 여전히 validateSessionPath 를 부른다');
  assert.ok(routeCreate.length >= 2,
    `fileJobRoutes.ts 의 validateCreatePath 호출 ${routeCreate.length}건 — 출발지와 목적지 둘 다여야 한다`);
  assert.ok(routeCreate.some((a) => a[1] === 'sourceSessionId'), '출발지(sourceSessionId) 검증이 validateCreatePath 가 아니다');
  assert.ok(routeCreate.some((a) => /\bdestSessionId\b/.test(a[1] ?? '')), '목적지(destSessionId) 검증이 validateCreatePath 가 아니다');

  const idx = await loadMasked(INDEX);
  assert.equal(callsOf(idx.code, /\bvalidateSessionPath/).length, 0, 'index.ts 가 validateSessionPath 를 부른다');
  const { deps } = managerOf(idx);
  assert.match(propertyOf(deps, 'validatePathFor') ?? '', /\bvalidateCreatePath\s*\(/,
    '관리자 validatePathFor 가 validateCreatePath 를 쓰지 않는다');
});

// 세션 종료 경로 중 DELETE /api/sessions/:id 만 onSessionDeleted 를 지난다. 탭·워크스페이스 삭제,
// 탭 재시작, PTY 종료는 SessionManager 의 finalizer 로 바로 가므로, 그 알림에도 취소가 걸려 있어야
// 삭제 작업이 끝까지 돌거나 복사·이동이 항목마다 SESSION_NOT_FOUND 로 실패하는 일이 없다.
// 구독 API 는 둘 다 받는다 — addSessionFinalizedListener(다중 구독) 가 onSessionFinalized(단일 슬롯,
// 다른 소비자를 덮어쓴다) 보다 안전하다.
function assertFinalizedCancelsJobs(idx: Masked): void {
  const { name: mgr } = managerOf(idx);
  const subs = callsOf(idx.code, /\bsessionManager\s*\.\s*(?:addSessionFinalizedListener|onSessionFinalized)/);
  const ok = subs.some((args) => {
    if (args.length !== 1) return false;
    const fn = args[0].trim();
    const arrow = /^(?:async\s+)?(?:\(\s*\{\s*sessionId(?:\s*:\s*(\w+))?\s*\}\s*(?::\s*\w+)?\s*\)|\(\s*(\w+)(?:\s*:\s*\w+)?\s*\)|(\w+))\s*=>/.exec(fn);
    if (!arrow) return false;
    const id = arrow[1] ?? (arrow[2] ?? arrow[3] ? `${arrow[2] ?? arrow[3]}\\s*\\.\\s*sessionId` : 'sessionId');
    return new RegExp(`\\b${mgr}\\s*(?:\\?\\.|\\.)\\s*cancelSessionJobs\\s*\\(\\s*${id}\\s*\\)`).test(fn.slice(arrow[0].length));
  });
  assert.ok(ok, `index.ts 가 세션 finalizer 알림에서 ${mgr}.cancelSessionJobs(<event.sessionId>) 를 부르지 않는다 — `
    + 'DELETE 라우트를 거치지 않는 세션 종료(탭 삭제·재시작·PTY 종료) 뒤에도 작업이 돈다');
}

// @req FR-FOP-003 AC-1
test('index.ts 가 세션 finalizer 알림에 cancelSessionJobs(event.sessionId) 를 건다 — 어떤 경로로 끝나든 작업이 세션과 함께 끝난다', async () => {
  const head = 'const fileJobManager = new FileJobManager({});\n';
  // 음성 대조: 주석·문자열 속 호출, 다른 id, 다른 관리자는 통과하면 안 된다.
  for (const bad of [
    '// sessionManager.addSessionFinalizedListener(({ sessionId }) => fileJobManager.cancelSessionJobs(sessionId));',
    'log("sessionManager.addSessionFinalizedListener(({ sessionId }) => fileJobManager.cancelSessionJobs(sessionId))");',
    'sessionManager.addSessionFinalizedListener((e) => fileJobManager.cancelSessionJobs(e.reason));',
    'sessionManager.addSessionFinalizedListener(({ sessionId }) => other.cancelSessionJobs(sessionId));',
  ]) {
    assert.throws(() => assertFinalizedCancelsJobs(mask(head + bad)), assert.AssertionError, `음성 대조가 통과했다: ${bad}`);
  }
  // 양성 대조: 두 구독 API 와 두 매개변수 형태를 모두 알아본다.
  for (const good of [
    'sessionManager.addSessionFinalizedListener(({ sessionId }) => fileJobManager.cancelSessionJobs(sessionId));',
    'sessionManager.onSessionFinalized((e) => fileJobManager.cancelSessionJobs(e.sessionId));',
    'sessionManager.onSessionFinalized(event => { fileJobManager.cancelSessionJobs(event.sessionId); });',
  ]) {
    assertFinalizedCancelsJobs(mask(head + good));
  }

  const idx = await loadMasked(INDEX);
  assertFileRoutesMountVisible(idx);
  assertFinalizedCancelsJobs(idx);
});

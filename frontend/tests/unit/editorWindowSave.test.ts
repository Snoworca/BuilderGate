import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEditorWindowSaveController } from '../../src/components/editor/editorWindowSave.ts';

// FR-MDE-006 AC-1 / AC-5 / AC-7 — the dirty transitions and the one save path.
//
// The dirty flag is judged here; the leading `*` it produces on the title is
// judged in tests/unit/windowDialogContract.test.ts, because WindowDialog is
// what draws the marker from the `dirty` prop.
//
// The window is bound to a tab and never to a session. restartTab keeps the tab
// and replaces its sessionId, so the session is resolved again on every call
// rather than captured when the controller is built.

const testDir = dirname(fileURLToPath(import.meta.url));
const moduleSourcePath = resolve(
  testDir,
  '../../src/components/editor/editorWindowSave.ts',
);

// The whole surface of the controller, written out rather than read back from
// the module. A list derived from the implementation would agree with any
// implementation, including one that grew a second write-issuing member --
// and a second one named `commit` or `flush` would slip past a name filter.
const CONTROLLER_MEMBERS = [
  'getBody',
  'getError',
  'handleEditorChange',
  'isDirty',
  'save',
];

interface RecordedWrite {
  sessionId: string;
  path: string;
  content: string;
}

/**
 * A writer that records what it was handed. It is not a stand-in for
 * `fileApi.writeFile` behaviour -- nothing here asserts on the HTTP layer --
 * it is the observation point for the three arguments the save path produces.
 */
function recordingWriter(outcome: 'ok' | 'reject' = 'ok') {
  const writes: RecordedWrite[] = [];
  const writeFile = async (sessionId: string, path: string, content: string) => {
    writes.push({ sessionId, path, content });
    if (outcome === 'reject') {
      throw new Error('EACCES: permission denied');
    }
    return { success: true };
  };
  return { writes, writeFile };
}

// Comments are stripped before the source is searched, so a comment that names
// the forbidden construct cannot fail the check and a real use cannot hide in
// one either.
function sourceWithoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('FR-MDE-006 typing marks the document dirty and updates the single body ref', () => {
  const writer = recordingWriter();
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.md' },
    bodyAtOpen: '# read from disk\n',
    deps: { resolveTabSession: () => 'S1', writeFile: writer.writeFile },
  });

  assert.equal(
    controller.isDirty(),
    false,
    'FR-MDE-006 AC-1: 디스크에서 막 읽어 온 창은 dirty 가 아니어야 한다',
  );
  assert.equal(controller.getBody(), '# read from disk\n');

  controller.handleEditorChange('# read from disk\nedited\n');

  assert.equal(
    controller.isDirty(),
    true,
    'FR-MDE-006 AC-1: 타이핑하면 dirty 가 되어야 한다',
  );
  assert.equal(
    controller.getBody(),
    '# read from disk\nedited\n',
    'FR-MDE-006 AC-1: 본문 ref 가 타이핑한 내용을 담아야 한다',
  );

  // 본문이 두 곳에 살면 읽는 자리와 쓰는 자리가 갈린다. 편집을 거듭한 뒤 읽는
  // 쪽(getBody)과 쓰는 쪽(writeFile 인자)이 같은 값을 보는지로 관측한다.
  controller.handleEditorChange('# read from disk\nedited twice\n');
  assert.equal(controller.getBody(), '# read from disk\nedited twice\n');

  // 본문 정본이 하나뿐이라는 요구는 React state 사본의 부재로도 표현된다.
  const moduleSource = sourceWithoutComments(readFileSync(moduleSourcePath, 'utf8'));
  assert.equal(
    /\buseState\b|^\s*import[^\n]*['"]react['"]/m.test(moduleSource),
    false,
    'FR-MDE-006 AC-1: 본문 정본은 ref 한 곳뿐이어야 하므로 이 모듈은 React state 를 쓰지 않는다',
  );
});

test('FR-MDE-006 the title bar button and the shortcut invoke one save function with the same arguments', async () => {
  const writer = recordingWriter();
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.md' },
    bodyAtOpen: 'original\n',
    deps: { resolveTabSession: () => 'S1', writeFile: writer.writeFile },
  });

  // 두 번째 저장 경로가 존재하면 그 자리에서 값이 갈린다. 이름 규칙이 아니라 표면
  // 전체를 고정한다 -- `commit` 이나 `flush` 로 불리는 두 번째 쓰기 경로는 이름
  // 필터를 통과하지만 이 단언은 통과하지 못한다.
  assert.deepEqual(
    Object.keys(controller).sort(),
    CONTROLLER_MEMBERS,
    'FR-MDE-006 AC-5: 저장을 내는 진입점은 save 하나여야 하며 컨트롤러 표면이 그 이상으로 늘면 안 된다',
  );

  controller.handleEditorChange('typed once\n');

  // 제목표시줄 저장 버튼이 부르는 것과 포커스 범위 Ctrl+S 가 부르는 것. 단축키
  // 핸들러는 저장 함수를 인자로 받아 부르므로 여기서는 그 전달을 흉내 낸다.
  const invokeFromTitleBarButton = () => controller.save();
  const invokeFromShortcut = ((save: () => Promise<unknown>) => () => save())(controller.save);

  const buttonOutcome = await invokeFromTitleBarButton();
  assert.deepEqual(buttonOutcome, { status: 'saved' });
  assert.equal(
    controller.isDirty(),
    false,
    'FR-MDE-006 AC-5: 저장이 성공하면 dirty 가 풀려야 한다',
  );

  // 두 번째 저장은 그 사이의 편집을 실어야 한다 -- 진입점이 자기 사본을 들고
  // 있으면 여기서 값이 갈린다.
  controller.handleEditorChange('typed twice\n');
  await invokeFromShortcut();

  assert.deepEqual(
    writer.writes,
    [
      { sessionId: 'S1', path: '/repo/CLAUDE.md', content: 'typed once\n' },
      { sessionId: 'S1', path: '/repo/CLAUDE.md', content: 'typed twice\n' },
    ],
    'FR-MDE-006 AC-5: 두 진입점의 쓰기 인자가 같은 저장 함수에서 같은 모양으로 나와야 한다',
  );
});

test('FR-MDE-006 a save after a tab restart carries the new session ID', async () => {
  const writer = recordingWriter();
  // 탭 재시작을 재현한다. tab.id 는 그대로이고 sessionId 만 S1 에서 S2 로 바뀐다.
  let liveSessionId = 'S1';
  const resolveCalls: string[] = [];
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/AGENTS.md' },
    bodyAtOpen: 'before\n',
    deps: {
      resolveTabSession: (tabId: string) => {
        resolveCalls.push(tabId);
        return tabId === 'tab-1' ? liveSessionId : undefined;
      },
      writeFile: writer.writeFile,
    },
  });

  controller.handleEditorChange('first edit\n');
  await controller.save();

  liveSessionId = 'S2';

  // 편집 없이 곧바로 다시 저장한다. 세션을 편집 시점에 캐시해 두는 구현은 여기서
  // S1 을 내보내며 걸린다 -- 재해결이 일어나야 하는 자리는 save 안이다.
  await controller.save();

  assert.deepEqual(
    writer.writes,
    [
      { sessionId: 'S1', path: '/repo/AGENTS.md', content: 'first edit\n' },
      { sessionId: 'S2', path: '/repo/AGENTS.md', content: 'first edit\n' },
    ],
    'FR-MDE-006 AC-7: 탭 재시작 뒤의 저장은 편집이 없었더라도 S2 로 나가야 한다',
  );

  // 재시작 뒤의 편집도 새 세션으로 나간다.
  controller.handleEditorChange('second edit\n');
  await controller.save();
  assert.deepEqual(
    writer.writes[2],
    { sessionId: 'S2', path: '/repo/AGENTS.md', content: 'second edit\n' },
    'FR-MDE-006 AC-7: 재시작 뒤의 편집은 새 세션으로 그 시점의 본문을 보내야 한다',
  );

  assert.deepEqual(
    resolveCalls,
    ['tab-1', 'tab-1', 'tab-1'],
    'FR-MDE-006 AC-7: 세션은 저장 호출마다 결속된 탭에서 다시 얻어야 한다',
  );
});

// 마이크로태스크만 배출한다. 타이머를 쓰지 않으므로 실행 시간에 기대지 않는다.
async function flushMicrotasks(): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    await Promise.resolve();
  }
}

test('FR-MDE-006 a save started while another is in flight writes after it, never over it', async () => {
  const started: string[] = [];
  const release: Array<() => void> = [];
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.md' },
    bodyAtOpen: 'before\n',
    deps: {
      resolveTabSession: () => 'S1',
      writeFile: async (_sessionId: string, _path: string, content: string) => {
        started.push(content);
        await new Promise<void>((resolve) => release.push(resolve));
        return { success: true };
      },
    },
  });

  controller.handleEditorChange('A\n');
  const first = controller.save();
  controller.handleEditorChange('B\n');
  const second = controller.save();

  await flushMicrotasks();
  assert.deepEqual(
    started,
    ['A\n'],
    'FR-MDE-006: 앞선 쓰기가 끝나기 전에 두 번째 쓰기가 시작되면 안 된다 — 도착 순서가 뒤집히면 낡은 본문이 디스크에 남는다',
  );

  release[0]();
  await first;
  await flushMicrotasks();
  assert.deepEqual(
    started,
    ['A\n', 'B\n'],
    'FR-MDE-006: 두 번째 쓰기는 첫 번째 뒤에 그 시점의 본문으로 나가야 한다',
  );

  release[1]();
  assert.deepEqual(await second, { status: 'saved' });
  assert.equal(
    controller.isDirty(),
    false,
    'FR-MDE-006: 마지막 쓰기가 현재 본문을 실었으면 dirty 가 풀려야 한다',
  );
});

test('FR-MDE-006 typing while a write is in flight keeps the document dirty', async () => {
  let releaseWrite: (() => void) | null = null;
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.md' },
    bodyAtOpen: 'before\n',
    deps: {
      resolveTabSession: () => 'S1',
      writeFile: async () => {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        return { success: true };
      },
    },
  });

  controller.handleEditorChange('sent\n');
  const inFlight = controller.save();
  await flushMicrotasks();

  controller.handleEditorChange('typed while saving\n');
  assert.ok(releaseWrite !== null, '쓰기가 시작되어야 이 시나리오가 성립한다');
  (releaseWrite as unknown as () => void)();
  await inFlight;

  assert.equal(
    controller.isDirty(),
    true,
    'FR-MDE-006: 저장 중에 친 글자는 저장된 것으로 셈하면 안 된다',
  );
  assert.equal(controller.getBody(), 'typed while saving\n');
});

test('FR-MDE-006 a write that resolves with success false is a failure, not a silent clean state', async () => {
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.md' },
    bodyAtOpen: 'before\n',
    deps: {
      resolveTabSession: () => 'S1',
      writeFile: async () => ({ success: false }),
    },
  });

  controller.handleEditorChange('unsaved work\n');
  const outcome = await controller.save();

  assert.equal(
    outcome.status,
    'failed',
    'FR-MDE-006: 거절을 표시한 응답을 성공으로 읽으면 * 가 사라진 채 본문이 유실된다',
  );
  assert.equal(controller.isDirty(), true);
  assert.notEqual(controller.getError(), null);
});

test('FR-MDE-006 a window whose tab has closed reports why it could not save', async () => {
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.md' },
    bodyAtOpen: 'before\n',
    deps: {
      resolveTabSession: () => undefined,
      writeFile: async () => {
        assert.fail('탭이 닫힌 창에서는 쓰기가 나가면 안 된다');
      },
    },
  });

  controller.handleEditorChange('unsaved work\n');
  assert.deepEqual(await controller.save(), { status: 'no-session' });
  assert.notEqual(
    controller.getError(),
    null,
    'FR-MDE-006: 창이 있는 이상 저장 실패는 그 창의 배너로 알려야 한다 — 아무 흔적도 없는 결과는 없다',
  );
  assert.equal(controller.isDirty(), true);
});

// 실패 경로는 AC-6 의 판정(E2E, T-PH007-11)과 별개로 이 모듈의 계약이다. 계획의
// action 이 "실패하면 dirty 를 유지한 채 배너로 오류를 표시한다" 를 요구하므로
// 그 분기를 여기서 고정한다.
test('FR-MDE-006 a failed write keeps the document dirty and produces a banner message', async () => {
  const writer = recordingWriter('reject');
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/repo/CLAUDE.local.md' },
    bodyAtOpen: 'before\n',
    deps: { resolveTabSession: () => 'S1', writeFile: writer.writeFile },
  });

  controller.handleEditorChange('unsaved work\n');
  const outcome = await controller.save();

  assert.equal(outcome.status, 'failed');
  assert.deepEqual(
    writer.writes,
    [{ sessionId: 'S1', path: '/repo/CLAUDE.local.md', content: 'unsaved work\n' }],
    'FR-MDE-006: 실패한 저장도 성공 경로와 같은 모양의 쓰기를 시도해야 한다',
  );
  assert.equal(
    controller.isDirty(),
    true,
    'FR-MDE-006: 쓰기가 실패하면 dirty 가 유지되어야 한다',
  );
  assert.match(
    controller.getError() ?? '',
    /EACCES/,
    'FR-MDE-006: 실패 사유가 배너 문구로 남아야 한다',
  );
  assert.equal(
    controller.getBody(),
    'unsaved work\n',
    'FR-MDE-006: 실패한 저장이 편집 중인 본문을 되돌리면 안 된다',
  );
});

// FR-FOP-002 AC-3 — 실제 fs 어댑터의 스트림 복사와 금지 호출 계약.
//
// 계약(T-PH001-04 가 이 형태로 구현한다):
//   export const nodeFileJobFsOps: FileJobFsOps   (fileJobFsOps.ts)
//   copyFileStream(src, dst, onBytes, signal?) — createReadStream({ highWaterMark: 64 KiB })
//     → createWriteStream 을 pipeline 으로 잇고, 청크마다 onBytes(그 청크의 바이트 수) 를
//     부른다. 누적값이 아니라 청크 크기다.
//
// 모듈은 테스트 안에서 동적으로 import 한다 — 부재가 러너 사망이 아니라 이 테스트의
// 이름 붙은 실패로 드러나게 하려는 것이다.
//
// 실제 파일은 os.tmpdir() 아래 realpath 임시 디렉터리에서만 만들고 finally 로 지운다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CopyCapable {
  copyFileStream(
    src: string,
    dst: string,
    onBytes: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

async function loadFsOps(): Promise<{ nodeFileJobFsOps: CopyCapable }> {
  return (await import('./fileJobFsOps.js')) as unknown as { nodeFileJobFsOps: CopyCapable };
}

const MIB = 1024 * 1024;
const CHUNK = 64 * 1024;

test('실제 어댑터로 1 MiB 임시 파일을 64 KiB 청크로 복사하면 완료 전에 onBytes 가 2회 이상 불리고 사본 바이트가 원본과 같다', async () => {
  const { nodeFileJobFsOps } = await loadFsOps();
  assert.equal(typeof nodeFileJobFsOps?.copyFileStream, 'function', 'nodeFileJobFsOps.copyFileStream 이 없다');

  const dir = await realpath(await mkdtemp(join(tmpdir(), 'bg-filejob-fsops-')));
  try {
    const src = join(dir, 'source.bin');
    const dst = join(dir, 'copy.bin');
    // 무작위 바이트 — 한 가지 값으로 채운 파일은 잘리거나 어긋난 사본도 같아 보인다.
    const original = randomBytes(MIB);
    await writeFile(src, original);

    const deltas: number[] = [];
    let settled = false;
    let partialBeforeSettle = 0;
    await nodeFileJobFsOps.copyFileStream(src, dst, (n) => {
      deltas.push(n);
      const cumulative = deltas.reduce((a, b) => a + b, 0);
      if (!settled && cumulative < MIB) partialBeforeSettle += 1;
    });
    settled = true;

    // 완료 전에 2회 이상 — 파일 전체를 한 번에 읽고 마지막에 한 번 보고하는 구현은
    // 호출 수 1 이거나, 여러 번 부르더라도 전부 누적 1 MiB 이후라 여기서 걸린다.
    assert.ok(deltas.length >= 2, `onBytes 호출 ${deltas.length}회`);
    assert.ok(partialBeforeSettle >= 1, `완료 전 중간 보고 없음: ${deltas.join(',')}`);
    // 청크 크기라는 계약: 각 값은 0 보다 크고 64 KiB 를 넘지 않으며 합이 정확히 파일 크기다.
    // 누적값을 넘기는 구현은 합이 파일 크기를 훌쩍 넘는다.
    for (const n of deltas) assert.ok(n > 0 && n <= CHUNK, `청크 ${n} B 가 (0, ${CHUNK}] 밖이다`);
    assert.equal(
      deltas.reduce((a, b) => a + b, 0),
      MIB,
    );

    const copied = await readFile(dst);
    assert.equal(copied.length, MIB);
    assert.ok(copied.equals(original), '사본 바이트가 원본과 다르다');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 위 테스트의 "완료 전" 은 await 뒤에 settled 를 세우므로 콜백 안에서는 항상 false 다 — 이름이
// 말하는 것을 실제로는 재지 못한다. 여기서는 promise 자체의 settle 을 then 으로 기록하고,
// 두 번째 onBytes 가 불리는 순간 그것이 아직 settle 되지 않았음을 건다. 파일을 다 쓴 뒤에
// 청크 보고를 몰아서 내는 구현은 두 번째 호출 시점에 이미 settle 되어 있거나, 호출이 한 번뿐이다.
test('실제 어댑터의 두 번째 onBytes 는 copyFileStream promise 가 settle 되기 전에 불린다', async () => {
  const { nodeFileJobFsOps } = await loadFsOps();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'bg-filejob-fsops-')));
  try {
    const src = join(dir, 'source.bin');
    const dst = join(dir, 'copy.bin');
    await writeFile(src, randomBytes(MIB));

    let settled = false;
    let calls = 0;
    let settledAtSecondCall: boolean | undefined;
    const copying = nodeFileJobFsOps.copyFileStream(src, dst, () => {
      calls += 1;
      if (calls === 2) settledAtSecondCall = settled;
    });
    const observed = copying.then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        settled = true;
        throw err;
      },
    );
    await observed;

    assert.ok(calls >= 2, `onBytes 호출 ${calls}회 — 두 번째 호출이 없다`);
    assert.equal(settledAtSecondCall, false, '두 번째 onBytes 시점에 복사 promise 가 이미 settle 되어 있었다');
    assert.equal(settled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 주석만 걷어낸다. 문자열 안의 금지 이름은 남겨 둔다 — 위양성보다 누락이 비싼 쪽이다.
// 이 저장소에서 주석 속 문자열이 단언을 대신 만족시킨 적이 있어 주석은 반드시 빼고 본다.
// 정규식 한 줄로 하면 같은 줄 앞쪽 문자열 안의 '//' 에서 줄 끝까지 지워져 그 뒤의 실제
// 호출이 빠지므로, 문자열·템플릿 리터럴을 건너뛰는 스캐너로 처리한다.
function stripComments(source: string): string {
  let out = '';
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
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      out += source.slice(start, i);
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// 스캐너 자기 점검: 문자열 속 '//' 뒤의 실제 호출은 남고, 주석 속 호출은 사라져야 한다.
// 이것이 틀리면 아래 부재 단언은 아무것도 보지 않은 채 통과한다.
function assertStripperSound(): void {
  const probe = 'const a = "x // y"; readFile(a); // copyFile(b)\n/* cpSync() */ ok();';
  const stripped = stripComments(probe);
  assert.match(stripped, /readFile\(a\)/, `stripComments 가 문자열 뒤 코드를 지웠다: ${stripped}`);
  assert.doesNotMatch(stripped, /copyFile|cpSync/, `stripComments 가 주석을 남겼다: ${stripped}`);
  assert.match(stripped, /ok\(\)/);
}

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // \b 로 끝을 막아 copyFileStream 은 걸리지 않는다.
  { name: 'fs.copyFile', pattern: /\bcopyFile\b/ },
  { name: 'copyFileSync', pattern: /\bcopyFileSync\b/ },
  { name: 'fs.cp', pattern: /\.cp\b|\bcp\s*\(/ },
  { name: 'cpSync', pattern: /\bcpSync\b/ },
  { name: 'readFile', pattern: /\breadFile(Sync)?\b/ },
];

test('fileJobFsOps.ts·fileJobRunner.ts 소스(주석 제거)에 fs.copyFile·copyFileSync·fs.cp·cpSync·readFile 호출이 없다', async () => {
  // 모듈이 실제로 존재해야 이 검사가 의미를 갖는다. 파일이 없거나 비어 있으면 금지
  // 호출이 "없다" 는 판정은 공짜로 나온다.
  await import('./fileJobFsOps.js');
  await import('./fileJobRunner.js');

  assertStripperSound();

  const sources = {
    'fileJobFsOps.ts': stripComments(await readFile(new URL('./fileJobFsOps.ts', import.meta.url), 'utf8')),
    'fileJobRunner.ts': stripComments(await readFile(new URL('./fileJobRunner.ts', import.meta.url), 'utf8')),
  };

  // 양성 대조: 어댑터는 스트림으로, 러너는 어댑터의 copyFileStream 으로 복사한다.
  // 이것이 없으면 복사를 아예 하지 않는 빈 모듈도 아래 부재 단언을 통과한다.
  assert.match(sources['fileJobFsOps.ts'], /\bcreateReadStream\b/);
  assert.match(sources['fileJobFsOps.ts'], /\bcreateWriteStream\b/);
  assert.match(sources['fileJobFsOps.ts'], /\bpipeline\b/);
  assert.match(sources['fileJobRunner.ts'], /\bcopyFileStream\b/);

  const hits: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) hits.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(hits, []);
});

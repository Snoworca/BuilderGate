// SEC-FOP-001 — 파일 조작 작업의 경로 검증을 한 곳에 둔다.
//
// 라우트(요청 수락 전)와 관리자(러너가 만드는 경로)가 같은 검증을 써야 한다. 두 곳이 각자
// 검증하면 한쪽만 고쳐졌을 때 "라우트는 거부하는데 러너는 만드는" 경로가 생긴다.
//
// 검증 기준은 언제나 그 경로가 속한 세션의 cwd 다. 출발지는 출발지 세션, 목적지는 목적지
// 세션 — 섞으면 한 세션의 권한으로 다른 세션의 트리를 건드릴 수 있다.
import fs from 'node:fs/promises';
import { isPathBlocked, resolveAndValidateEntry, type ValidatedEntry } from '../../utils/pathValidator.js';

// @req SEC-FOP-001
export interface FileJobPathPolicy {
  /** 세션의 작업 루트. 없는 세션은 AppError(SESSION_NOT_FOUND) 로 reject 한다. */
  getCwd(sessionId: string): Promise<string>;
  blockedPaths: readonly string[];
}

export interface FileJobPathOptions {
  /**
   * 작업을 받을 때 captureSessionRoot 로 고정한 세션 루트. 없으면 부를 때마다 세션의 지금 cwd 를 읽는다 —
   * 요청을 받는 순간의 검증(라우트)에는 그것이 맞지만, 도는 작업에서는 사용자가 터미널에서 cd 할 때마다
   * 검증 기준이 바뀌어 멀쩡한 목적지가 "세션 밖" 이 된다.
   */
  root?: Promise<string>;
  /** true 면 실제 경로뿐 아니라 항목 자신의 위치(entryPath)도 돌려준다. 삭제·이동의 출발지에 쓴다. */
  entry?: boolean;
}

/**
 * p 가 sessionId 세션의 cwd 안이고 blocked path 가 아니면 실제 경로를, 아니면
 * AppError(PATH_TRAVERSAL · PATH_BLOCKED · SESSION_NOT_FOUND · PERMISSION_DENIED ·
 * FILE_OPERATION_FAILED) 로 reject 한다. 작업이 새로 만들 경로(목적지)에도, 이미 있는 경로(출발지·
 * 덮어쓰기)에도 쓴다.
 *
 * 알고리즘은 공용 resolveAndValidateEntry 하나에 둔다 — 아직 없는 경로는 가장 가까운 기존 조상을 realpath 로
 * 풀어 그 실제 위치로 traversal·blocked 를 보고, cwd 도 실제 경로로 비교한다. 여기서 따로 구현하면
 * 파일 API 와 파일 작업 중 한쪽만 고쳐지는 보안 경로가 다시 생긴다.
 *
 * options.entry 면 { realPath, entryPath } 를 돌려준다. 출발지는 entryPath 로 다뤄야 한다 — 출발지 자신이
 * 링크일 때 realPath 는 링크 대상이라, 그것을 지우거나 옮기면 사용자가 고른 링크가 아니라 대상이 사라진다.
 */
// @req SEC-FOP-001
export function validateCreatePath(
  policy: FileJobPathPolicy,
  sessionId: string,
  p: string,
  options?: FileJobPathOptions & { entry?: false },
): Promise<string>;
export function validateCreatePath(
  policy: FileJobPathPolicy,
  sessionId: string,
  p: string,
  options: FileJobPathOptions & { entry: true },
): Promise<ValidatedEntry>;
export async function validateCreatePath(
  policy: FileJobPathPolicy,
  sessionId: string,
  p: string,
  options: FileJobPathOptions = {},
): Promise<string | ValidatedEntry> {
  const cwd = options.root !== undefined ? await options.root : await policy.getCwd(sessionId);
  // blockedPaths 는 고정하지 않는다 — 설정 화면에서 새로 막은 경로는 도는 작업에도 곧바로 적용되어야 한다.
  // 공용 검증기는 가변 배열을 받는다 — 정책의 목록을 넘겨주다 바뀌지 않게 복사한다.
  const validated = await resolveAndValidateEntry(cwd, p, [...policy.blockedPaths]);
  return options.entry === true ? validated : validated.realPath;
}

/**
 * 세션 루트를 지금 한 번 읽어 실제 경로로 고정한다. 작업을 받을 때 부르고, 그 작업의 모든 검증에
 * validateCreatePath(…, { root }) 로 넘긴다. 실제 경로로 고정하는 이유: cwd 가 링크·8.3 이름이면 뒤에서
 * 그 이름이 다른 곳을 가리키게 되어도 작업이 처음 받은 트리를 기준으로 남는다.
 *
 * 없는 세션이면 돌려준 promise 가 reject 한다. 아무도 기다리지 않는 경우(삭제 작업의 목적지 검증기)에
 * 처리되지 않은 거부로 남지 않게, 처리됨으로 표시한 뒤 원래 promise 를 돌려준다 — 기다리는 쪽은 여전히
 * 그 거부를 받는다.
 */
// @req SEC-FOP-001
export function captureSessionRoot(policy: FileJobPathPolicy, sessionId: string): Promise<string> {
  const root = Promise.resolve()
    .then(() => policy.getCwd(sessionId))
    .then((cwd) => fs.realpath(cwd).catch(() => cwd));
  root.catch(() => {});
  return root;
}

/**
 * 러너가 스캔 중 만나는 자손마다 부르는 blocked 판정. 최상위 출발지와 만드는 경로는 validateCreatePath 가
 * 보지만, 디렉터리 안의 자손은 따로 검증되지 않는다 — 여기서 걸러야 '.ssh' 같은 자손이 복사·삭제·이동된다.
 * 목록은 부를 때마다 정책에서 새로 읽는다.
 */
// @req SEC-FOP-001
export function isFileJobPathBlocked(policy: FileJobPathPolicy, p: string): boolean {
  return isPathBlocked(p, policy.blockedPaths);
}

/**
 * validateCreatePath 의 별칭. 공용 검증기가 없는 경로까지 실제 위치로 보게 된 뒤로 두 검증은 같다.
 * 테스트가 이 이름으로 가져가므로 남겨 둔다 — 운영 배선은 validateCreatePath 를 쓴다(fileJobWiring 가드).
 */
// @req SEC-FOP-001
export const validateSessionPath = validateCreatePath;

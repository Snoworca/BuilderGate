// SEC-FOP-001 — 파일 조작 작업의 경로 검증을 한 곳에 둔다.
//
// 라우트(요청 수락 전)와 관리자(러너가 만드는 경로)가 같은 검증을 써야 한다. 두 곳이 각자
// 검증하면 한쪽만 고쳐졌을 때 "라우트는 거부하는데 러너는 만드는" 경로가 생긴다.
//
// 검증 기준은 언제나 그 경로가 속한 세션의 cwd 다. 출발지는 출발지 세션, 목적지는 목적지
// 세션 — 섞으면 한 세션의 권한으로 다른 세션의 트리를 건드릴 수 있다.
import { resolveAndValidate } from '../../utils/pathValidator.js';

// @req SEC-FOP-001
export interface FileJobPathPolicy {
  /** 세션의 작업 루트. 없는 세션은 AppError(SESSION_NOT_FOUND) 로 reject 한다. */
  getCwd(sessionId: string): Promise<string>;
  blockedPaths: readonly string[];
}

/**
 * p 가 sessionId 세션의 cwd 안이고 blocked path 가 아니면 실제 경로를, 아니면
 * AppError(PATH_TRAVERSAL · PATH_BLOCKED · SESSION_NOT_FOUND · PERMISSION_DENIED ·
 * FILE_OPERATION_FAILED) 로 reject 한다. 작업이 새로 만들 경로(목적지)에도, 이미 있는 경로(출발지·
 * 덮어쓰기)에도 쓴다.
 *
 * 알고리즘은 공용 resolveAndValidate 하나에 둔다 — 아직 없는 경로는 가장 가까운 기존 조상을 realpath 로
 * 풀어 그 실제 위치로 traversal·blocked 를 보고, cwd 도 실제 경로로 비교한다. 여기서 따로 구현하면
 * 파일 API 와 파일 작업 중 한쪽만 고쳐지는 보안 경로가 다시 생긴다.
 */
// @req SEC-FOP-001
export async function validateCreatePath(
  policy: FileJobPathPolicy,
  sessionId: string,
  p: string,
): Promise<string> {
  const cwd = await policy.getCwd(sessionId);
  // resolveAndValidate 는 가변 배열을 받는다 — 정책의 목록을 넘겨주다 바뀌지 않게 복사한다.
  return resolveAndValidate(cwd, p, [...policy.blockedPaths]);
}

/**
 * validateCreatePath 의 별칭. 공용 검증기가 없는 경로까지 실제 위치로 보게 된 뒤로 두 검증은 같다.
 * 테스트가 이 이름으로 가져가므로 남겨 둔다 — 운영 배선은 validateCreatePath 를 쓴다(fileJobWiring 가드).
 */
// @req SEC-FOP-001
export const validateSessionPath = validateCreatePath;

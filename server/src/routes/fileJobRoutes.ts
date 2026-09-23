/**
 * IR-FOP-001 · IR-FOP-002 · SEC-FOP-001 · FR-FOP-003 · FR-FOP-005 — 파일 조작 작업의 REST 진입점.
 *
 * '/api/file-jobs' 에 express.json() 뒤로, 인증 미들웨어와 함께 마운트된다. 인증은 fileRoutes 와
 * 같이 마운트하는 쪽(index.ts)이 붙인다 — 라우터가 스스로 붙이면 같은 요청이 두 번 검사되거나
 * 한쪽 규약만 바뀌었을 때 어긋난다.
 *
 * 라우트는 넷뿐이다. 작업별 진행 조회(GET /:jobId)는 두지 않는다 — 진행은 WebSocket 으로만
 * 가고, 폴링 경로가 생기면 클라이언트가 두 채널의 서로 다른 시점을 섞어 보게 된다.
 *
 * 경로는 manager.start 전에 전부 검증한다. 관리자도 출발지를 검증하지만 비동기 검증은 작업을
 * 등록한 뒤에 끝나므로, 거기에만 맡기면 거부될 요청이 jobId 를 받고 목록에 잠깐 나타난다.
 */

import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import {
  FileJobManager,
  FileJobManagerError,
  type FileJobManagerErrorCode,
} from '../services/fileJobs/fileJobManager.js';
import { validateCreatePath, type FileJobPathPolicy } from '../services/fileJobs/fileJobPaths.js';
import type { FileJobConflictChoice, FileJobSpec } from '../services/fileJobs/fileJobRunner.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { isSessionRootTarget } from '../utils/pathValidator.js';

const OPERATIONS: readonly FileJobSpec['operation'][] = ['copy', 'move', 'delete'];

const MANAGER_ERROR_STATUS: Record<FileJobManagerErrorCode, number> = {
  JOB_NOT_FOUND: 404,
  JOB_NOT_AWAITING: 409,
  DECISION_MISMATCH: 409,
  INVALID_CHOICE: 400,
  // 서버 종료 중이다 — 클라이언트가 다시 시도할 수 있는 상태로 알린다.
  MANAGER_DISPOSED: 503,
};

class InvalidInput extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (!isNonEmptyString(value)) throw new InvalidInput(`${field} is required and must be a non-empty string`);
  return value;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/**
 * 절대 경로만 받는다. 검증은 세션 cwd 기준으로 경로를 풀어 보지만 파일 연산은 받은 문자열을 서버
 * 프로세스의 cwd 기준으로 푼다 — 상대 경로를 받으면 검증한 곳과 지우는 곳이 달라진다. win32 에서는
 * 드라이브 상대('C:foo', 그 드라이브의 현재 디렉터리 기준)와 루트 상대('\foo', 현재 드라이브 기준)도
 * 같은 이유로 거부한다 — path.win32.isAbsolute 는 뒤의 것을 절대 경로로 본다. UNC 는 서버·공유 이름이 있을 때만 받는다.
 */
// @req IR-FOP-001
// @req SEC-FOP-001
export function isAcceptedAbsolutePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || isUncShareRootedPath(p);
  return path.posix.isAbsolute(p);
}

/**
 * '\\server\share\...' — 서버와 공유 이름이 둘 다 있는 UNC 경로. 매핑된 드라이브의 cwd 가 UNC 로 풀리는 호스트에서는
 * 세션의 모든 경로가 이 모양이다. 공유 이름까지 있어야 기준이 고정된다('\\server' 만으로는 어느 트리인지 모른다).
 * '\\?\' · '\\.\' 는 장치 네임스페이스라 받지 않는다 — 정규화를 건너뛰어 검증한 문자열과 여는 대상이 달라질 수 있다.
 */
function isUncShareRootedPath(p: string): boolean {
  const root = path.win32.parse(p).root;
  const match = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(root);
  return match !== null && match[1] !== '?' && match[1] !== '.';
}

function requireAbsolute(p: string, field: string): string {
  if (!isAcceptedAbsolutePath(p)) throw new InvalidInput(`${field} must be absolute paths`);
  return p;
}

interface StartRequest {
  sourceSessionId: string;
  destSessionId?: string;
  spec: FileJobSpec;
}

// @req IR-FOP-001
function parseStart(body: Record<string, unknown>): StartRequest {
  const operation = body.operation;
  if (typeof operation !== 'string' || !OPERATIONS.includes(operation as FileJobSpec['operation'])) {
    throw new InvalidInput(`operation must be one of: ${OPERATIONS.join(', ')}`);
  }
  const sourceSessionId = requireString(body, 'sourceSessionId');
  const sources = body.sources;
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every(isNonEmptyString)) {
    throw new InvalidInput('sources must be a non-empty array of non-empty strings');
  }
  for (const source of sources) requireAbsolute(source, 'sources');
  let destSessionId: string | undefined;
  if (body.destSessionId !== undefined) destSessionId = requireString(body, 'destSessionId');

  const op = operation as FileJobSpec['operation'];
  // 받은 문자열 그대로다. 러너에는 검증한 경로가 따로 가고, 이것은 done 의 affectedDirectories 를
  // 클라이언트가 보낸 모양으로 만드는 데만 쓴다.
  const spec: FileJobSpec = { operation: op, sources: [...sources] };
  if (op !== 'delete') {
    spec.destDir = requireAbsolute(requireString(body, 'destPath'), 'destPath');
  }
  return { sourceSessionId, destSessionId, spec };
}

// @req FR-FOP-003
function parseDecision(body: Record<string, unknown>): {
  decisionId: string;
  choice: FileJobConflictChoice;
  applyToAll?: boolean;
} {
  const decisionId = requireString(body, 'decisionId');
  // 선택지의 유효성은 질문마다 다르므로 관리자가 판정한다(INVALID_CHOICE). 여기서는 모양만 본다.
  const choice = requireString(body, 'choice') as FileJobConflictChoice;
  const applyToAll = body.applyToAll;
  if (applyToAll !== undefined && typeof applyToAll !== 'boolean') {
    throw new InvalidInput('applyToAll must be a boolean when present');
  }
  return applyToAll === undefined ? { decisionId, choice } : { decisionId, choice, applyToAll };
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof InvalidInput) {
    res.status(400).json({ error: { code: ErrorCode.INVALID_INPUT, message: err.message } });
  } else if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
  } else if (err instanceof FileJobManagerError) {
    res.status(MANAGER_ERROR_STATUS[err.code] ?? 500).json({ error: { code: err.code, message: err.message } });
  } else {
    // 경로나 요청 본문을 로그에 싣지 않는다 — 사용자의 디렉터리 구조가 서버 로그로 새지 않게.
    console.error('[FileJobRoutes] Unexpected error:', err instanceof Error ? err.name : typeof err);
    res.status(500).json({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal server error',
        timestamp: new Date().toISOString(),
      },
    });
  }
}

// @req FR-FOP-003
// @req FR-FOP-005
// @req IR-FOP-001
// @req IR-FOP-002
// @req SEC-FOP-001
export function createFileJobRoutes(manager: FileJobManager, pathPolicy: FileJobPathPolicy): Router {
  const router = Router();

  // POST /api/file-jobs — 작업 시작
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { sourceSessionId, destSessionId, spec } = parseStart(bodyOf(req));
      // 출발지는 출발지 세션, 목적지는 목적지 세션 기준. 하나라도 거부되면 작업을 만들지 않는다.
      // validateCreatePath 를 쓴다 — 가장 가까운 기존 조상을 realpath 로 풀어 cwd 와 비교하므로, cwd 가
      // 링크나 8.3 이름일 때 원시 cwd 문자열과 비교하는 validateSessionPath 처럼 정상 경로를 거부하지 않는다.
      //
      // 러너에는 검증한 값을 넘긴다. 받은 문자열을 넘기면 러너가 그것을 다시 풀 때(부모 사슬의 링크가 그
      // 사이 바뀌었거나, POSIX 에서 'link/..' 가 링크 대상의 부모로 풀릴 때) 검증하지 않은 곳에 닿는다.
      // 출발지는 항목 자신의 위치(entryPath)다 — 출발지가 링크면 대상이 아니라 링크를 옮기고 지워야 한다.
      const validated: FileJobSpec = { operation: spec.operation, sources: [] };
      // 검증과 루트 판정이 같은 cwd 를 보게 한 번만 읽는다 — 그 사이 cd 하면 둘이 다른 루트를 기준으로 삼는다.
      const sourceCwd = await pathPolicy.getCwd(sourceSessionId);
      const sourceRoot = Promise.resolve(sourceCwd);
      for (const source of spec.sources) {
        const entry = await validateCreatePath(pathPolicy, sourceSessionId, source, { entry: true, root: sourceRoot });
        // 세션 루트는 세션 밖의 부모에 있는 항목이라 경로 검증이 거부하지 않는다. 판정은 FileService 와 같은
        // 공용 isSessionRootTarget 이다 — 한쪽만 고쳐지면 REST 와 파일 작업 중 하나로 프로젝트를 지울 수 있다.
        if (await isSessionRootTarget(sourceCwd, { resolved: path.resolve(source), entryPath: entry.entryPath })) {
          // 지우거나 옮기면 세션이 선 폴더가 사라진다 — 뜻한 요청일 수 없다.
          if (spec.operation !== 'copy') {
            throw new InvalidInput(`sources must not be the session folder itself for ${spec.operation}`);
          }
          // 복사는 내용을 읽을 뿐이라 링크 자신이 누구인지는 상관없다. 루트의 entryPath 는 cwd 가 링크·8.3 이름일 때
          // 실제 루트 밖의 철자라, 관리자가 고정한 실제 루트 기준의 출발지 검증에서 거부된다 — 실제 경로를 넘긴다.
          validated.sources.push(entry.realPath);
          continue;
        }
        validated.sources.push(entry.entryPath);
      }
      if (spec.destDir !== undefined) {
        // 목적지는 그 안에 만들 디렉터리이므로 실제 경로다.
        validated.destDir = await validateCreatePath(pathPolicy, destSessionId ?? sourceSessionId, spec.destDir);
      } else if (destSessionId !== undefined) {
        // delete 에는 검증할 목적지 경로가 없다. 그래도 관리자는 작업을 그 세션에 묶어 목록·방송·
        // 세션 종료 취소에 쓰므로, 없는 세션에 묶인 작업이 생기지 않게 존재만은 확인한다.
        await pathPolicy.getCwd(destSessionId);
      }
      const { jobId } = manager.start({ sourceSessionId, destSessionId, spec: validated, requestedSpec: spec });
      res.status(202).json({ jobId });
    } catch (err) {
      handleError(err, res);
    }
  });

  // POST /api/file-jobs/:jobId/decision — 대기 중인 질문에 답
  router.post('/:jobId/decision', (req: Request<{ jobId: string }>, res: Response) => {
    try {
      manager.decide(req.params.jobId, parseDecision(bodyOf(req)));
      res.status(200).json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  // DELETE /api/file-jobs/:jobId — 취소. 끝난 작업의 보존 기록이 있으면 404 가 아니라 ignored 다.
  router.delete('/:jobId', (req: Request<{ jobId: string }>, res: Response) => {
    try {
      const result = manager.cancel(req.params.jobId);
      if (result.outcome === 'not-found') {
        throw new FileJobManagerError('JOB_NOT_FOUND', `File job not found: ${req.params.jobId}`);
      }
      res.status(200).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  // GET /api/file-jobs[?sessionId=] — 비종료 작업 목록 + 대기 중 질문 재전송
  router.get('/', (req: Request, res: Response) => {
    try {
      const raw = req.query.sessionId;
      // ?sessionId=a&sessionId=b 는 배열이 된다. 그것을 "필터 없음" 으로 읽으면 모든 작업을 돌려주고
      // 모든 세션에 재전송하므로 거부한다.
      if (raw !== undefined && typeof raw !== 'string') {
        throw new InvalidInput('sessionId must be a single string when present');
      }
      const sessionId = raw !== undefined && raw.length > 0 ? raw : undefined;
      const jobs = manager.list(sessionId).map((job) => ({
        ...job,
        pendingDecision: manager.getPendingDecision(job.jobId),
      }));
      // 재접속한 쪽이 이 조회로 따라잡는다. 세션마다 한 번만 — resendPendingDecisions 가 그 세션의
      // 대기 질문을 전부 보내므로, 작업마다 부르면 같은 질문이 여러 번 간다.
      if (sessionId !== undefined) {
        manager.resendPendingDecisions(sessionId);
      } else {
        const sessions = new Set<string>();
        for (const job of jobs) {
          if (job.pendingDecision === null) continue;
          sessions.add(job.sourceSessionId);
          sessions.add(job.destSessionId);
        }
        for (const s of sessions) manager.resendPendingDecisions(s);
      }
      res.status(200).json({ jobs });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

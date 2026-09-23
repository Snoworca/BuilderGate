// FR-FOP-002 — 파일 조작 작업이 실제 디스크에 닿는 유일한 곳.
//
// 러너는 이 인터페이스만 본다. 테스트는 같은 인터페이스를 메모리로 구현해 호출 순서를
// 기록하고, 운영은 여기의 node:fs 구현을 쓴다. 어댑터에는 판단을 두지 않는다 — 충돌·검증·
// 진행 집계는 전부 러너 몫이고, 여기는 한 번에 한 연산만 한다.
//
// 복사는 반드시 스트림으로 한다. 한 번에 읽어 쓰는 API 는 파일 전체를 메모리에 올리고,
// OS 복사 API 는 끝날 때까지 진행을 알려 주지 않아 큰 파일에서 진행 막대가 멈춘다.
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

// @req FR-FOP-002
export interface FileJobFsStat {
  /** symlink 는 링크 자신이다(Windows junction 포함). 대상의 종류·크기는 담지 않는다. */
  kind: 'file' | 'directory' | 'symlink';
  size: number;
}

// @req FR-FOP-005
export interface FileJobCopyOptions {
  /** true 면 resolve 전에 사본의 데이터를 디스크에 flush 한다. 원본을 곧 지울 복사(이동)에 쓴다. */
  durable?: boolean;
}

// @req FR-FOP-002
export interface FileJobFsOps {
  /** 없으면 null. 링크는 따라가지 않는다. */
  lstat(p: string): Promise<FileJobFsStat | null>;
  /**
   * 링크를 모두 푼 실제 경로. 러너는 링크 대상을 출발지 세션 정책으로 검사하고 순환을 끊는 데
   * 쓴다. 없는 구현(메모리 fs 등)이면 러너는 링크를 따라가지 않는다 — 풀 수 없는 링크는 거부한다.
   */
  realpath?(p: string): Promise<string>;
  /** 이름만 돌려준다. */
  readdir(p: string): Promise<string[]>;
  /** 한 단계만 만든다. 이미 있으면 EEXIST 로 실패한다 — 러너가 충돌을 먼저 물었어야 한다. */
  mkdir(p: string): Promise<void>;
  /**
   * onBytes 는 청크마다 그 청크의 바이트 수로 불린다(누적값이 아니다).
   * dst 는 배타적으로 만든다 — 이미 있으면 EEXIST 로 실패한다. 러너는 없다고 확인한 경로나 새
   * 임시 이름에만 쓰므로, 그 사이에 생긴 파일은 남의 것이고 잘라서는 안 된다.
   */
  copyFileStream(
    src: string,
    dst: string,
    onBytes: (n: number) => void,
    signal?: AbortSignal,
    options?: FileJobCopyOptions,
  ): Promise<void>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  /**
   * existing 의 하드 링크를 newPath 에 만든다. newPath 가 있으면 EEXIST 로 실패하고 그 파일을 건드리지 않는다 —
   * 러너가 새 파일을 "없을 때만" 원자적으로 놓는 데 쓴다. 하드 링크가 없는 볼륨은 EPERM·ENOTSUP 등으로 실패하고
   * 러너는 lstat 재확인 + rename 으로 되돌아간다. 없는 구현(메모리 fs 등)도 그 길을 탄다.
   */
  hardLink?(existing: string, newPath: string): Promise<void>;
}

/**
 * 청크 크기. 진행 보고의 해상도이자 한 번에 메모리에 머무는 양의 상한이다.
 * 기본값(64 KiB)과 같지만 계약이므로 명시한다 — 기본값이 바뀌어도 보고 간격이 따라 바뀌면 안 된다.
 */
const CHUNK_BYTES = 64 * 1024;

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

// @req FR-FOP-002
export const nodeFileJobFsOps: FileJobFsOps = {
  async lstat(p) {
    let st;
    try {
      st = await lstat(p);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null;
      throw err;
    }
    if (st.isDirectory()) return { kind: 'directory', size: 0 };
    if (st.isFile()) return { kind: 'file', size: st.size };
    // 링크는 링크로 보고한다. 파일·디렉터리로 보고하면 러너가 대상을 검증 없이 따라가고, 던지면
    // 링크 하나 때문에 작업 전체가 실패한다. 크기는 싣지 않는다 — 링크 자신의 크기는 전송량이 아니다.
    if (st.isSymbolicLink()) return { kind: 'symlink', size: 0 };
    // 장치·소켓은 거부한다. 스트림으로 읽으면 끝나지 않거나(FIFO) 파일이 아닌 것을 파일로
    // 복사하게 되고, 인터페이스의 어느 종류로 보고해도 거짓이 된다.
    const err = new Error(`Unsupported file type (not a regular file or directory): ${p}`) as Error & {
      code: string;
    };
    err.code = 'EUNSUPPORTEDTYPE';
    throw err;
  },

  async realpath(p) {
    return realpath(p);
  },

  async readdir(p) {
    return readdir(p);
  },

  async mkdir(p) {
    await mkdir(p);
  },

  async copyFileStream(src, dst, onBytes, signal, options) {
    // 청크를 다음 단계로 넘긴 뒤에 보고한다. 넘겼다는 것이 디스크에 썼다는 뜻은 아니어서
    // 보고가 실제 쓰기보다 버퍼 몇 개만큼 앞설 수 있다 — 진행 표시에는 충분한 정밀도다.
    // 파이프라인 한가운데의 생성기라 역압(backpressure)은 그대로 유지된다.
    async function* countChunks(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        yield chunk;
        onBytes(chunk.length);
      }
    }
    const reader = createReadStream(src, { highWaterMark: CHUNK_BYTES });
    let writer;
    try {
      writer = createWriteStream(dst, { flags: 'wx' });
    } catch (err) {
      // 쓰기 쪽이 동기적으로 던지면(잘못된 경로 인자 등) 이미 연 읽기 핸들이 새지 않게 닫는다.
      reader.destroy();
      throw err;
    }
    // 취소 시 부분 파일 정리는 이 연산을 부른 쪽(러너) 몫이다. 여기서는 스트림을 끊고, 쓰기
    // 핸들이 실제로 닫힌 뒤에 reject 한다 — Windows 에서는 열린 핸들 아래의 unlink 가
    // EBUSY/EPERM 으로 실패하므로, 핸들이 남은 채 돌려주면 러너의 정리가 부분본을 남긴다.
    try {
      if (signal) {
        await pipeline(reader, countChunks, writer, { signal });
      } else {
        await pipeline(reader, countChunks, writer);
      }
    } catch (err) {
      reader.destroy();
      writer.destroy();
      // once(emitter, 'close') 는 뒤늦은 'error' 로 reject 하므로 close 만 기다린다.
      if (!writer.closed) await new Promise<void>((resolve) => writer.once('close', () => resolve()));
      throw err;
    }
    if (options?.durable) {
      // pipeline 은 데이터가 OS 캐시에 들어가면 끝난다. 곧바로 원본을 지우면 정전 뒤 삭제만
      // 반영되고 사본은 빈 채로 남을 수 있으므로, 원본 삭제 전에 사본을 flush 한다.
      const handle = await open(dst, 'r+');
      try {
        await handle.datasync();
      } finally {
        await handle.close();
      }
    }
  },

  async unlink(p) {
    await unlink(p);
  },

  async rmdir(p) {
    await rmdir(p);
  },

  async rename(src, dst) {
    await rename(src, dst);
  },

  async hardLink(existing, newPath) {
    await link(existing, newPath);
  },
};

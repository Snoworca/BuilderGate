// FR-FEX-023 (#139), FR-MCP-021 (#234): stores one uploaded request body at its destination. The
// body streams into a hidden temporary file in the destination folder and is renamed into place
// after the last byte. Shared by the file explorer upload (behind the JWT) and the one-use MCP
// upload URL (/mcp/fu).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { once } from 'node:events';
import { newUploadTempName, type UploadTempRegistry } from './uploadTemp.js';
import { placeExclusively } from './placeExclusively.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

export type UploadConflict = 'fail' | 'overwrite' | 'rename' | 'skip';

export interface StoreUploadInput {
  body: IncomingMessage;
  /** The destination file, already checked by FileService. */
  target: string;
  conflict: UploadConflict;
  /** Bytes; a larger body is refused (FILE_TOO_LARGE). */
  limit: number;
  registry: UploadTempRegistry;
  /** Judges the folder that will hold the file again after missing folders were made. */
  revalidateParent: (parent: string) => Promise<void>;
  /** Opens the temp file for writing; tests replace it to inject write errors. */
  openTempFile?: (filePath: string) => Writable;
}

/** stored: the file is in place; skipped: conflict 'skip' met an existing name; aborted: the client went away. */
export type StoreUploadResult =
  | { kind: 'stored'; finalPath: string; size: number }
  | { kind: 'skipped'; finalPath: string }
  | { kind: 'aborted' };

// 'wx': the random name is ours alone.
const openTempFileDefault = (filePath: string): Writable => fs.createWriteStream(filePath, { flags: 'wx' });

/**
 * Stores the body. Refusals and failures throw AppError; the temp file never outlives the call
 * unless the file was placed.
 */
export async function storeUploadBody(input: StoreUploadInput): Promise<StoreUploadResult> {
  const { body, registry } = input;
  const declared = body.headers['content-length'] === undefined ? null : Number(body.headers['content-length']);
  if (declared !== null && (!Number.isFinite(declared) || declared < 0)) throw new AppError(ErrorCode.INVALID_INPUT, 'Invalid Content-Length');
  // FR-FEX-023 AC-4: refused before a byte is written when the declared size is already too large.
  if (declared !== null && declared > input.limit) throw new AppError(ErrorCode.FILE_TOO_LARGE);

  let finalPath = input.target;
  const existing = await fsp.lstat(finalPath).catch(() => null);
  if (existing !== null) {
    if (input.conflict === 'skip') return { kind: 'skipped', finalPath };
    // FR-FEX-023 AC-7: a conflict is answered without writing; overwrite never replaces a folder.
    if (input.conflict === 'fail' || (input.conflict === 'overwrite' && existing.isDirectory())) {
      throw new AppError(ErrorCode.FILE_ALREADY_EXISTS);
    }
  }

  const parent = path.dirname(finalPath);
  try {
    await fsp.mkdir(parent, { recursive: true });
  } catch (err) {
    throw uploadFsError(err, 'Create directory');
  }
  await input.revalidateParent(parent);

  let tempPath: string | null = path.join(parent, newUploadTempName());
  const discardTemp = async (): Promise<void> => {
    if (tempPath === null) return;
    const stale = tempPath;
    tempPath = null;
    await fsp.unlink(stale).catch(() => undefined);
    await registry.remove(stale);
  };
  try {
    await registry.add(tempPath);
    const outcome = await receiveBody(body, tempPath, input.limit, input.openTempFile ?? openTempFileDefault);
    if (outcome.kind === 'aborted') {
      await discardTemp();
      return { kind: 'aborted' };
    }
    if (outcome.kind === 'failed') {
      throw outcome.error instanceof AppError ? outcome.error : uploadFsError(outcome.error, 'Write');
    }
    // FR-FEX-023 AC-7: placed without replacing anything unless overwrite was asked for, so a name
    // taken while the bytes arrived (another upload, a shell) is never lost.
    if (input.conflict === 'overwrite') {
      const now = await fsp.lstat(finalPath).catch(() => null);
      if (now?.isDirectory()) throw new AppError(ErrorCode.FILE_ALREADY_EXISTS);
      try {
        await fsp.rename(tempPath, finalPath);
      } catch (err) {
        throw uploadFsError(err, 'Rename');
      }
    } else {
      try {
        finalPath = await placeExclusively(tempPath, finalPath, input.conflict === 'rename');
      } catch (err) {
        throw uploadFsError(err, 'Place');
      }
      await fsp.unlink(tempPath).catch(() => undefined);
    }
    const placed = tempPath;
    tempPath = null;
    await registry.remove(placed);
    return { kind: 'stored', finalPath, size: outcome.size };
  } catch (err) {
    await discardTemp();
    throw err;
  }
}

export function uploadFsError(err: unknown, action: string): AppError {
  if (err instanceof AppError) return err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return new AppError(ErrorCode.PERMISSION_DENIED);
  // A file where a folder of the path should be.
  if (code === 'EEXIST' || code === 'ENOTDIR') return new AppError(ErrorCode.FILE_ALREADY_EXISTS);
  if (code === 'ENOSPC') return new AppError(ErrorCode.FILE_OPERATION_FAILED, 'No space left on the device');
  return new AppError(ErrorCode.FILE_OPERATION_FAILED, `${action} failed: ${(err as Error).message}`);
}

type ReceiveOutcome = { kind: 'done'; size: number } | { kind: 'aborted' } | { kind: 'failed'; error: unknown };

/**
 * Copies the request body into the temp file. The request is piped, never put in a pipeline: a
 * write error or the size limit stops the writing but leaves the request alone, so the client can
 * still be answered. A request that closes before its last byte is the client going away. The temp
 * file is closed before this returns, which Windows needs to rename or delete it.
 */
async function receiveBody(req: IncomingMessage, tempPath: string, limit: number, open: (filePath: string) => Writable): Promise<ReceiveOutcome> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        callback(new AppError(ErrorCode.FILE_TOO_LARGE));
        return;
      }
      callback(null, chunk);
    },
  });
  const file = open(tempPath);
  const outcome = await new Promise<ReceiveOutcome>((resolve) => {
    let settled = false;
    const settle = (value: ReceiveOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.once('aborted', () => settle({ kind: 'aborted' }));
    req.once('close', () => {
      if (!req.complete) settle({ kind: 'aborted' });
    });
    counter.once('error', (error) => settle({ kind: 'failed', error }));
    file.once('error', (error) => settle({ kind: 'failed', error }));
    file.once('finish', () => settle({ kind: 'done', size }));
    req.pipe(counter).pipe(file);
  });
  if (outcome.kind !== 'done') {
    req.unpipe(counter);
    counter.unpipe(file);
    counter.destroy();
    if (!file.destroyed) file.destroy();
  }
  if (!(file as Writable & { closed?: boolean }).closed) await once(file, 'close').catch(() => undefined);
  return outcome;
}

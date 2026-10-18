// FR-FEX-023 AC-7, FR-FOP-007 AC-7: put a finished temporary file at a name only when that name is
// free, as one filesystem step, so nothing that appeared in the meantime is replaced.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveNameCollision } from '../fileNameCollision.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

/** Codes a filesystem gives when it cannot make hard links. */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL']);

/**
 * Puts the temp file's content at `finalPath` only if that name is free, as one filesystem step
 * (a hard link, or an exclusive copy where links are not supported). With `rename`, a taken name
 * moves on to the next FR-FOP-004 name; otherwise it is FILE_ALREADY_EXISTS. The temp file stays;
 * the caller removes it.
 */
export async function placeExclusively(tempPath: string, finalPath: string, rename: boolean): Promise<string> {
  const parent = path.dirname(finalPath);
  const wanted = path.basename(finalPath);
  const tried = new Set<string>();
  let useLink = true;
  let candidate = wanted;
  for (;;) {
    const destination = path.join(parent, candidate);
    try {
      if (useLink) await fsp.link(tempPath, destination);
      else await fsp.copyFile(tempPath, destination, fs.constants.COPYFILE_EXCL);
      return destination;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        if (!rename) throw new AppError(ErrorCode.FILE_ALREADY_EXISTS);
        tried.add(candidate);
        candidate = resolveNameCollision(wanted, (name) => tried.has(name) || fs.existsSync(path.join(parent, name)));
        continue;
      }
      if (useLink && code !== undefined && NO_LINK.has(code)) {
        useLink = false;
        continue;
      }
      throw err;
    }
  }
}


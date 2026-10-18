// FR-FOP-007 (#140): archives built byte by byte for the extraction tests, so a test can carry what
// no well-behaved archiver writes: '..' and absolute names, links, devices, encrypted flags, a split
// archive, declared sizes that lie, names in CP949. Test support only.
import zlib from 'node:zlib';
import tar from 'tar-stream';

export interface ZipFixtureEntry {
  /** A string is written as UTF-8; set utf8Flag to false to leave the flag off. A Buffer is written as is. */
  name: string | Buffer;
  data?: Buffer;
  /** 0 stored, 8 deflate (default), or any other number for an unsupported method. */
  method?: number;
  utf8Flag?: boolean;
  encrypted?: boolean;
  /** The uncompressed size the headers claim; defaults to the real size. */
  declaredSize?: number;
  /** Unix mode in the high 16 bits of the external attributes (e.g. 0o120777 for a symlink). */
  unixMode?: number;
  /** DOS date and time; defaults to 2024-05-06 07:08:10. */
  dosDate?: number;
  dosTime?: number;
}

const DEFAULT_DOS_DATE = ((2024 - 1980) << 9) | (5 << 5) | 6;
const DEFAULT_DOS_TIME = (7 << 11) | (8 << 5) | 5;

/** A ZIP with the given entries. diskNumber other than 0 makes it look like part of a split archive. */
export function buildZip(entries: ZipFixtureEntry[], options: { diskNumber?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name;
    let flags = 0;
    if (typeof entry.name === 'string' && entry.utf8Flag !== false) flags |= 0x800;
    if (entry.encrypted) flags |= 0x1;
    const crc = zlib.crc32(data);
    const size = entry.declaredSize ?? data.length;
    const date = entry.dosDate ?? DEFAULT_DOS_DATE;
    const time = entry.dosTime ?? DEFAULT_DOS_TIME;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 30, 4); // made by Unix, so the mode bits count
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

export interface TarFixtureEntry {
  name: string;
  /** Any tar type tar-stream knows, or 'gnu-long-path' for a hand-written GNU long name record (data = the name). */
  type?: tar.Header['type'] | 'gnu-long-path';
  data?: Buffer;
  linkname?: string;
  mtime?: Date;
}

/** One raw 512-byte tar header block (GNU magic), checksum filled in. */
function rawTarHeader(name: string, typeflag: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(typeflag, 156, 'ascii');
  block.write('ustar  \0', 257, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

function padToBlock(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

/** Packs one entry with tar-stream and returns its blocks without the end-of-archive marker. */
async function packOne(entry: TarFixtureEntry): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    pack.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
    pack.on('end', () => resolve());
    pack.on('error', reject);
  });
  const header = {
    name: entry.name,
    type: (entry.type ?? 'file') as tar.Header['type'],
    mtime: entry.mtime ?? new Date('2024-05-06T07:08:10Z'),
    mode: entry.type === 'directory' ? 0o755 : 0o644,
  };
  if (entry.linkname !== undefined) Object.assign(header, { linkname: entry.linkname });
  const carriesData = entry.type === undefined || entry.type === 'file';
  await new Promise<void>((resolve, reject) => {
    const callback = (err?: Error | null): void => (err ? reject(err) : resolve());
    if (carriesData) pack.entry(header, entry.data ?? Buffer.alloc(0), callback);
    else pack.entry(header, callback);
  });
  pack.finalize();
  await done;
  const raw = Buffer.concat(chunks);
  return raw.subarray(0, raw.length - 1024);
}

/**
 * A tar (gzip-compressed when gzip is set). tar-stream writes a pax header for a name over 100
 * bytes; a 'gnu-long-path' entry is written by hand as a GNU 'L' record whose data names the next entry.
 */
export async function buildTar(entries: TarFixtureEntry[], options: { gzip?: boolean } = {}): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.type === 'gnu-long-path') {
      const data = entry.data ?? Buffer.alloc(0);
      parts.push(rawTarHeader('././@LongLink', 'L', data.length), padToBlock(data));
    } else {
      parts.push(await packOne(entry));
    }
  }
  parts.push(Buffer.alloc(1024));
  const raw = Buffer.concat(parts);
  return options.gzip ? zlib.gzipSync(raw) : raw;
}

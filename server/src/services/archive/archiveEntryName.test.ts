// FR-FOP-007 AC-2, AC-6 (#140): entry name normalization and ZIP name decoding, without the disk.
// Run: cwd=server/, npx tsx --test src/services/archive/archiveEntryName.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import iconv from 'iconv-lite';
import { ARCHIVE_ENTRY_REFUSAL, decodeZipEntryName, normalizeEntryPath } from './archiveEntryName.js';

test('FR-FOP-007 AC-2: entry paths become segments or a refusal', () => {
  assert.deepEqual(normalizeEntryPath('./a/b.txt'), { kind: 'path', segments: ['a', 'b.txt'], isDirectory: false });
  assert.deepEqual(normalizeEntryPath('a\\b\\'), { kind: 'path', segments: ['a', 'b'], isDirectory: true });
  assert.deepEqual(normalizeEntryPath('a//b'), { kind: 'path', segments: ['a', 'b'], isDirectory: false });
  assert.deepEqual(normalizeEntryPath('./'), { kind: 'root' });
  const refused: Array<[string, string]> = [
    ['../x', ARCHIVE_ENTRY_REFUSAL.outside],
    ['a/../../x', ARCHIVE_ENTRY_REFUSAL.outside],
    ['a/..', ARCHIVE_ENTRY_REFUSAL.outside],
    ['/etc/passwd', ARCHIVE_ENTRY_REFUSAL.absolute],
    ['\\\\server\\share\\x', ARCHIVE_ENTRY_REFUSAL.absolute],
    ['C:\\x', ARCHIVE_ENTRY_REFUSAL.absolute],
    ['c:x', ARCHIVE_ENTRY_REFUSAL.absolute],
    ['a\u0000b', ARCHIVE_ENTRY_REFUSAL.invalidName],
    ['dir/AUX', ARCHIVE_ENTRY_REFUSAL.invalidName],
    ['lpt1.txt', ARCHIVE_ENTRY_REFUSAL.invalidName],
    ['x.exe.', ARCHIVE_ENTRY_REFUSAL.invalidName],
    ['x ', ARCHIVE_ENTRY_REFUSAL.invalidName],
    ['dir/ab:stream', ARCHIVE_ENTRY_REFUSAL.invalidName],
  ];
  for (const [name, reason] of refused) assert.deepEqual(normalizeEntryPath(name), { kind: 'refused', reason }, JSON.stringify(name));
});

test('FR-FOP-007 AC-6: ZIP names decode by Unicode field, UTF-8 flag, valid UTF-8, then CP949', () => {
  const cp949 = iconv.encode('보고서.txt', 'cp949');
  assert.equal(decodeZipEntryName(cp949, 0), '보고서.txt');
  assert.equal(decodeZipEntryName(Buffer.from('유니코드.txt', 'utf8'), 0), '유니코드.txt');
  assert.equal(decodeZipEntryName(Buffer.from('플래그.txt', 'utf8'), 0x800), '플래그.txt');
  const unicode = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), Buffer.from('확장필드.txt', 'utf8')]);
  unicode.writeUInt32LE(zlib.crc32(cp949), 1);
  assert.equal(decodeZipEntryName(cp949, 0, [{ id: 0x7075, data: unicode }]), '확장필드.txt');
  unicode.writeUInt32LE(0, 1);
  assert.equal(decodeZipEntryName(cp949, 0, [{ id: 0x7075, data: unicode }]), '보고서.txt', 'a stale Unicode field is ignored');
});

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePaths = [
  'src/benchmarks/terminalFairnessCharacterization.ts',
  'src/benchmarks/fairSchedulerAuthorityLocator.ts',
  'src/ws/wsSendPolicy.ts',
  'src/ws/WsRouter.ts',
  'src/services/TerminalResourcePolicy.ts',
  'src/services/TerminalResourcePolicyCanary.ts',
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

const contents = await Promise.all(sourcePaths.map(path => readFile(resolve(serverRoot, path), 'utf8')));
const unsignedManifest = {
  schemaVersion: 'fair-scheduler-source-provenance/v1',
  inputs: sourcePaths.map((path, index) => ({ path, sha256: sha256(contents[index]) })),
  sourceDigest: sha256(contents),
};
const manifest = {
  ...unsignedManifest,
  manifestDigest: sha256(unsignedManifest),
};
const outputPath = resolve(serverRoot, 'dist/benchmarks/fair-scheduler-source-provenance.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${canonicalJson(manifest)}\n`, 'utf8');

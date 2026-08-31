import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalAuthorityPath = 'docs/analysis/terminal-fairness-authority';
const defaultOutputRoot = resolve(serverRoot, 'dist/benchmarks/fair-scheduler-evidence');
const currentFile = 'current.json';
const generationsDirectory = 'generations';
const decisionFile = 'fair-scheduler-decision.json';
const provenanceFile = 'provenance.json';
const rawRoot = 'raw';
const rawManifestFile = 'raw/manifest.json';

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeRelativePath(value, directory = false) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')
    || isAbsolute(value) || win32.isAbsolute(value) || value.startsWith('./')) return false;
  const normalized = directory ? value.slice(0, -1) : value;
  return (!directory || value.endsWith('/'))
    && normalized.length > 0
    && normalized.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

function hasSymbolicLinkAncestor(path) {
  let candidate = resolve(path);
  while (true) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) return true;
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

function resolveContained(root, declaredPath, label, directory = false) {
  if (!isSafeRelativePath(declaredPath, directory)) {
    throw new Error(`${label} must be a normalized relative authority path`);
  }
  const relativePath = directory ? declaredPath.slice(0, -1) : declaredPath;
  const result = resolve(root, ...relativePath.split('/'));
  const contained = relative(root, result);
  if (contained.length === 0 || isAbsolute(contained) || contained === '..' || contained.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the authority root`);
  }
  if (hasSymbolicLinkAncestor(result)) throw new Error(`${label} has a symbolic-link authority root`);
  if (existsSync(root) && existsSync(result)) {
    const realContained = relative(realpathSync(root), realpathSync(result));
    if (isAbsolute(realContained) || realContained === '..' || realContained.startsWith(`..${sep}`)) {
      throw new Error(`${label} escapes the authority root`);
    }
  }
  return result;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unreadable`, { cause: error });
  }
}

async function collectFiles(root, relativeDirectory = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    const entryPath = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('authority generation contains a symbolic link');
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error('authority generation contains an unsupported file type');
    }
  }
  return files;
}

async function readCanonicalAuthority(authorityRoot) {
  if (hasSymbolicLinkAncestor(authorityRoot)) throw new Error('canonical authority has a symbolic-link root');
  const currentPath = resolveContained(authorityRoot, currentFile, 'canonical pointer');
  const pointer = await readJson(currentPath, 'canonical pointer');
  if (!isRecord(pointer)
    || pointer.schema_version !== 'fair-scheduler-current-authority/v1'
    || !isSha256(pointer.generation_id)
    || pointer.publication_generation !== pointer.generation_id
    || pointer.decision_artifact !== decisionFile
    || pointer.provenance_artifact !== provenanceFile
    || pointer.raw_root !== `${rawRoot}/`
    || !isSha256(pointer.decision_sha256)
    || !isSha256(pointer.provenance_sha256)
    || !isSha256(pointer.raw_manifest_sha256)) {
    throw new Error('canonical authority pointer is invalid');
  }

  const generationDirectory = `${generationsDirectory}/${pointer.generation_id}`;
  const generationRoot = resolveContained(authorityRoot, generationDirectory, 'canonical generation');
  const decisionPath = resolveContained(generationRoot, pointer.decision_artifact, 'canonical decision');
  const provenancePath = resolveContained(generationRoot, pointer.provenance_artifact, 'canonical provenance');
  const rawDirectory = resolveContained(generationRoot, pointer.raw_root, 'canonical raw root', true);
  const manifestPath = resolveContained(generationRoot, rawManifestFile, 'canonical raw manifest');
  const [decisionBytes, provenanceBytes, manifestBytes] = await Promise.all([
    readFile(decisionPath),
    readFile(provenancePath),
    readFile(manifestPath),
  ]);
  if (sha256(decisionBytes) !== pointer.decision_sha256
    || sha256(provenanceBytes) !== pointer.provenance_sha256
    || sha256(manifestBytes) !== pointer.raw_manifest_sha256) {
    throw new Error('canonical authority digest mismatch');
  }

  const provenance = await readJson(provenancePath, 'canonical provenance');
  const manifest = await readJson(manifestPath, 'canonical raw manifest');
  if (!isRecord(provenance)
    || provenance.schema_version !== 'fair-scheduler-source-provenance/v1'
    || provenance.generation_id !== pointer.generation_id
    || provenance.canonical_locator !== 'docs/analysis/terminal-fairness-authority/current.json'
    || provenance.publication_generation !== pointer.publication_generation
    || provenance.decision_path !== decisionFile
    || provenance.decision_sha256 !== pointer.decision_sha256
    || provenance.provenance_path !== provenanceFile
    || provenance.raw_root !== `${rawRoot}/`
    || provenance.raw_manifest_path !== rawManifestFile
    || provenance.raw_manifest_sha256 !== pointer.raw_manifest_sha256
    || !isSha256(provenance.policy_digest)
    || !Array.isArray(provenance.trial_inventory)
    || !isRecord(manifest)
    || manifest.schema_version !== 'fair-scheduler-raw-manifest/v1'
    || manifest.generation_id !== pointer.generation_id
    || !Array.isArray(manifest.entries)) {
    throw new Error('canonical authority provenance is invalid');
  }

  const rawEntries = [];
  const expectedRawFiles = new Set([rawManifestFile]);
  for (const entry of manifest.entries) {
    if (!isRecord(entry) || !isSafeRelativePath(entry.path) || !entry.path.startsWith(`${rawRoot}/`) || !isSha256(entry.sha256)) {
      throw new Error('canonical authority raw manifest is invalid');
    }
    if (expectedRawFiles.has(entry.path)) throw new Error('canonical authority raw manifest is invalid');
    const rawPath = resolveContained(generationRoot, entry.path, 'canonical raw entry');
    const bytes = await readFile(rawPath);
    if (sha256(bytes) !== entry.sha256) throw new Error('canonical authority raw entry digest mismatch');
    expectedRawFiles.add(entry.path);
    rawEntries.push(entry);
  }
  const actualRawFiles = new Set((await collectFiles(rawDirectory)).map(path => `${rawRoot}/${path}`));
  if (actualRawFiles.size !== expectedRawFiles.size || [...expectedRawFiles].some(path => !actualRawFiles.has(path))) {
    throw new Error('canonical authority raw inventory is invalid');
  }

  if (sha256(canonicalJson({
    schema_version: pointer.schema_version,
    decision_sha256: pointer.decision_sha256,
    raw_entries_digest: sha256(canonicalJson(rawEntries)),
    policy_digest: provenance.policy_digest,
    trial_inventory: provenance.trial_inventory,
  })) !== pointer.generation_id) {
    throw new Error('canonical authority generation identity is invalid');
  }

  const files = [currentFile, ...((await collectFiles(generationRoot)).map(path => `${generationDirectory}/${path}`))];
  return { currentPath, generationDirectory, generationId: pointer.generation_id, files };
}

function assertNoSourceRootOverride(input) {
  if (Object.prototype.hasOwnProperty.call(input, 'sourceRoot')) {
    throw new Error('sourceRoot override is forbidden; canonical authority is the only supported source root');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'repositoryRoot')) {
    throw new Error('repositoryRoot override is forbidden; canonical authority is bound to this repository');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'outputRoot')) {
    throw new Error('outputRoot override is forbidden; compiled bundle destination is fixed');
  }
}

async function copyCanonicalAuthority(sourceRoot, stagingRoot, bundle) {
  for (const path of bundle.files) {
    const sourcePath = resolveContained(sourceRoot, path, 'canonical authority source');
    const outputPath = resolveContained(stagingRoot, path, 'canonical authority staging');
    await mkdir(dirname(outputPath), { recursive: true });
    await copyFile(sourcePath, outputPath);
  }
}

async function removeInactiveGenerations(outputRoot, activeGenerationId) {
  const outputGenerations = resolveContained(outputRoot, generationsDirectory, 'compiled generations');
  if (!existsSync(outputGenerations)) return;
  for (const entry of await readdir(outputGenerations, { withFileTypes: true })) {
    if (entry.name === activeGenerationId) continue;
    const entryPath = resolve(outputGenerations, entry.name);
    if (entry.isSymbolicLink()) throw new Error('compiled authority generation is a symbolic link');
    await rm(entryPath, { recursive: true, force: true });
  }
}

async function removeUnselectedOutputEntries(outputRoot, stagingRoot) {
  const permitted = new Set([
    currentFile,
    generationsDirectory,
    '.fair-scheduler-authority.publish.lock',
    basename(stagingRoot),
  ]);
  for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
    if (permitted.has(entry.name)) continue;
    const entryPath = resolve(outputRoot, entry.name);
    if (entry.isSymbolicLink()) throw new Error('compiled authority output contains a symbolic link');
    await rm(entryPath, { recursive: true, force: true });
  }
}

async function acquirePublishLock(outputRoot) {
  const lockPath = join(outputRoot, '.fair-scheduler-authority.publish.lock');
  const handle = await open(lockPath, 'wx').catch(error => {
    if (error?.code === 'EEXIST') throw new Error('canonical authority publication lock exists');
    throw error;
  });
  return { handle, lockPath };
}

export async function writeFairSchedulerEvidenceBundle(input = {}) {
  assertNoSourceRootOverride(input);
  const sourceRoot = resolve(serverRoot, '..', ...canonicalAuthorityPath.split('/'));
  const outputRoot = defaultOutputRoot;
  if (hasSymbolicLinkAncestor(sourceRoot) || hasSymbolicLinkAncestor(outputRoot)) {
    throw new Error('canonical authority source or output has a symbolic-link root');
  }
  const bundle = await readCanonicalAuthority(sourceRoot);
  await mkdir(outputRoot, { recursive: true });
  const lock = await acquirePublishLock(outputRoot);
  let stagingRoot;
  try {
    await input.afterPublishLockAcquired?.();
    stagingRoot = await mkdtemp(join(outputRoot, '.fair-scheduler-authority.staging-'));
    await copyCanonicalAuthority(sourceRoot, stagingRoot, bundle);
    await input.beforeStagedValidation?.({ stagingRoot, bundle });
    await readCanonicalAuthority(stagingRoot);
    const staged = await (input.validateStaged?.({ stagingRoot, bundle }) ?? { accepted: true, reason: 'canonical-authority-verified' });
    if (!staged.accepted) throw new Error(`staged canonical authority rejected: ${staged.reason}`);
    const runtime = await (input.validateRuntime?.({ stagingRoot, bundle }) ?? { accepted: true, reason: 'canonical-authority-verified' });
    if (!runtime.accepted) throw new Error(`compiled canonical authority rejected: ${runtime.reason}`);

    const stagedGeneration = resolveContained(stagingRoot, bundle.generationDirectory, 'staged canonical generation');
    const outputGeneration = resolveContained(outputRoot, bundle.generationDirectory, 'compiled canonical generation');
    await mkdir(dirname(outputGeneration), { recursive: true });
    if (existsSync(outputGeneration)) {
      const outputBundle = await readCanonicalAuthority(outputRoot);
      if (outputBundle.generationId !== bundle.generationId) {
        throw new Error('compiled authority current generation differs from staged authority');
      }
    } else {
      await rename(stagedGeneration, outputGeneration);
    }
    await input.beforeCanonicalPointerPromotion?.({ outputRoot, bundle });
    await readCanonicalAuthority(outputRoot).catch(() => undefined);
    const stagedCurrent = resolveContained(stagingRoot, currentFile, 'staged canonical pointer');
    const outputCurrent = resolveContained(outputRoot, currentFile, 'compiled canonical pointer');
    await rename(stagedCurrent, outputCurrent);
    await removeInactiveGenerations(outputRoot, bundle.generationId);
    await removeUnselectedOutputEntries(outputRoot, stagingRoot);
    return {
      evidenceRoot: relative(serverRoot, outputRoot).replaceAll('\\', '/'),
      fileCount: bundle.files.length,
      generationId: bundle.generationId,
    };
  } finally {
    if (stagingRoot && existsSync(stagingRoot) && !hasSymbolicLinkAncestor(stagingRoot)) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    await lock.handle.close();
    if (existsSync(lock.lockPath) && !lstatSync(lock.lockPath).isSymbolicLink()) {
      await rm(lock.lockPath, { force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await writeFairSchedulerEvidenceBundle();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

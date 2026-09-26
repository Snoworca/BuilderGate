import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type * as ImageViewerModelModule from '../../src/components/editor/imageViewerModel.ts';

// FR-MDE-018 AC-3 / AC-4 / AC-5 / AC-6 / AC-8, SEC-MDE-001 AC-1 / AC-3 / AC-4
// -- the image viewer's pure model and the source guards on its component.
//
// Contract fixed here for src/components/editor/imageViewerModel.ts (pure, loads
// under `node --experimental-strip-types`):
//
//   type Size = { width: number; height: number }
//   type ImageViewState = {
//     mode: 'fit' | 'actual' | 'free';
//     scale: number;
//     offsetX: number;   // image centre relative to the stage centre, CSS px
//     offsetY: number;
//   }
//   MIN_SCALE, MAX_SCALE: number          (MIN_SCALE < 1 < MAX_SCALE)
//   fitScale(viewport: Size, natural: Size) -> min(vw/nw, vh/nh, 1)
//   initialViewState(viewport, natural) -> { mode: 'fit', scale: fitScale, offset 0 }
//   toggleFit(state, viewport, natural)
//       fit  -> { mode: 'actual', scale: 1, offset 0 }
//       else -> initialViewState(viewport, natural)
//   applyWheel(state, { deltaY, x, y }) -> ImageViewState
//       x/y are the cursor relative to the stage centre. deltaY < 0 zooms in,
//       > 0 zooms out. The image point under the cursor stays under the cursor,
//       scale is clamped to [MIN_SCALE, MAX_SCALE], mode becomes 'free'.
//   applyPinch(state, { previousDistance, distance, x, y }) -> ImageViewState
//       scale *= distance / previousDistance about the pinch centre (x, y),
//       same anchoring, clamping and mode as applyWheel.
//   applyPan(state, dx, dy) -> offset moved by (dx, dy), scale unchanged.
//   formatImageInfo(width, height, bytes) -> "1920 × 1080 · 2.0 MB"
//   describeImageError(failure) -> string, the message shown inside the tab
//       failure = { kind: 'read'; error: unknown } | { kind: 'decode' }
//       'read' errors are classified by the server code that survives in the
//       thrown message (see utils/editorFileMenu.ts isMissingFileError):
//         FILE_TOO_LARGE -> too large
//         PATH_NOT_FOUND -> missing (the plan names this FILE_NOT_FOUND; the
//                           server's code for a missing path is PATH_NOT_FOUND)
//         anything else  -> rejected
//       'decode' is the <img> onerror (corrupt bytes).
//   createBlobUrlSlot() -> { replace(blob): string; current(): string | null;
//                            dispose(): void }
//       uses the global URL.createObjectURL / URL.revokeObjectURL.
//
// The module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named. The `import type` line is erased
// at runtime and lets tsc check the calls against the real signatures.
const MODULE_PATH = '../../src/components/editor/imageViewerModel.ts';
type Mod = typeof ImageViewerModelModule;

async function loadModule(): Promise<Mod> {
  return await import(MODULE_PATH) as Mod;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const editorDir = resolve(testDir, '../../src/components/editor');
const viewerPath = join(editorDir, 'ImageFileViewer.tsx');
const srcDir = resolve(testDir, '../../src');

/** Comments removed, so prose that names a forbidden API is not read as a use. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
    .replace(/([;{}(),\s])\/\/[^\n]*$/gm, '$1');
}

function readViewer(): string {
  assert.ok(existsSync(viewerPath), `ImageFileViewer.tsx exists at ${relative(srcDir, viewerPath)}`);
  return stripComments(readFileSync(viewerPath, 'utf8'));
}

/** The JSX element opened by `<name` up to its closing `>` (braces counted). */
function jsxElement(source: string, name: string): string | null {
  const start = source.search(new RegExp(`<${name}\\b`));
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function listFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, pattern));
    } else if (pattern.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Image point under stage point (x, y) for a given view state. */
function imagePointAt(state: { scale: number; offsetX: number; offsetY: number }, x: number, y: number) {
  return { u: (x - state.offsetX) / state.scale, v: (y - state.offsetY) / state.scale };
}

const CLOSE = 1e-9;

test('initialViewState 는 fit; toggleFit 이 fit ↔ actual(scale 1) 을 오간다; fit scale = min(뷰포트/원본, 1)', async () => {
  // TC-REQ-FR-MDE-018-AC3-01
  const m = await loadModule();
  const viewport = { width: 800, height: 600 };

  // Larger than the viewport: the tighter axis decides.
  const big = { width: 1920, height: 1080 };
  assert.ok(Math.abs(m.fitScale(viewport, big) - 800 / 1920) < CLOSE, 'width-bound fit');
  assert.ok(Math.abs(m.fitScale(viewport, { width: 1000, height: 1200 }) - 0.5) < CLOSE, 'height-bound fit');
  // Smaller than the viewport: never enlarged past 100%.
  assert.equal(m.fitScale(viewport, { width: 100, height: 50 }), 1, 'small image is not enlarged');

  const initial = m.initialViewState(viewport, big);
  assert.deepEqual(initial, { mode: 'fit', scale: m.fitScale(viewport, big), offsetX: 0, offsetY: 0 });

  const actual = m.toggleFit(initial, viewport, big);
  assert.deepEqual(actual, { mode: 'actual', scale: 1, offsetX: 0, offsetY: 0 });

  const back = m.toggleFit(actual, viewport, big);
  assert.deepEqual(back, initial, 'toggling from actual returns to fit');

  // From a zoomed/panned free state the button goes back to fit, not to 100%.
  const free = { mode: 'free' as const, scale: 3, offsetX: 40, offsetY: -12 };
  assert.deepEqual(m.toggleFit(free, viewport, big), initial);
});

test('applyWheel·applyPinch 가 커서/핀치 중심 기준으로 scale 을 한계 안에서 바꾸고 applyPan 이 offset 을 옮긴다', async () => {
  // TC-REQ-FR-MDE-018-AC4-01
  const m = await loadModule();
  assert.ok(m.MIN_SCALE > 0 && m.MIN_SCALE < 1 && m.MAX_SCALE > 1, 'limits bracket 100%');

  const start = { mode: 'fit' as const, scale: 0.5, offsetX: 10, offsetY: -20 };
  const cursor = { x: 120, y: 80 };
  const before = imagePointAt(start, cursor.x, cursor.y);

  // Wheel up zooms in about the cursor.
  const zoomedIn = m.applyWheel(start, { deltaY: -100, ...cursor });
  assert.ok(zoomedIn.scale > start.scale, `wheel up zooms in (${zoomedIn.scale})`);
  assert.equal(zoomedIn.mode, 'free');
  const afterIn = imagePointAt(zoomedIn, cursor.x, cursor.y);
  assert.ok(Math.abs(afterIn.u - before.u) < 1e-6 && Math.abs(afterIn.v - before.v) < 1e-6,
    'the image point under the cursor stays under the cursor');

  // Wheel down zooms out about the cursor.
  const zoomedOut = m.applyWheel(start, { deltaY: 100, ...cursor });
  assert.ok(zoomedOut.scale < start.scale, `wheel down zooms out (${zoomedOut.scale})`);
  const afterOut = imagePointAt(zoomedOut, cursor.x, cursor.y);
  assert.ok(Math.abs(afterOut.u - before.u) < 1e-6 && Math.abs(afterOut.v - before.v) < 1e-6);

  // Clamped at both ends.
  let s: ImageViewerModelModule.ImageViewState = start;
  for (let i = 0; i < 200; i += 1) s = m.applyWheel(s, { deltaY: -500, x: 0, y: 0 });
  assert.equal(s.scale, m.MAX_SCALE, 'zoom in stops at MAX_SCALE');
  for (let i = 0; i < 400; i += 1) s = m.applyWheel(s, { deltaY: 500, x: 0, y: 0 });
  assert.equal(s.scale, m.MIN_SCALE, 'zoom out stops at MIN_SCALE');

  // Pinch: scale follows the distance ratio about the pinch centre.
  const centre = { x: -60, y: 30 };
  const pinchBefore = imagePointAt(start, centre.x, centre.y);
  const pinched = m.applyPinch(start, { previousDistance: 100, distance: 150, ...centre });
  assert.ok(Math.abs(pinched.scale - start.scale * 1.5) < CLOSE, `pinch scales by 150/100 (${pinched.scale})`);
  assert.equal(pinched.mode, 'free');
  const pinchAfter = imagePointAt(pinched, centre.x, centre.y);
  assert.ok(Math.abs(pinchAfter.u - pinchBefore.u) < 1e-6 && Math.abs(pinchAfter.v - pinchBefore.v) < 1e-6,
    'the image point under the pinch centre stays put');
  const pinchedHard = m.applyPinch(start, { previousDistance: 1, distance: 1e6, x: 0, y: 0 });
  assert.equal(pinchedHard.scale, m.MAX_SCALE, 'pinch is clamped too');

  // Pan moves the offset only.
  const panned = m.applyPan(start, 15, -7);
  assert.equal(panned.scale, start.scale);
  assert.equal(panned.offsetX, start.offsetX + 15);
  assert.equal(panned.offsetY, start.offsetY - 7);
});

test('formatImageInfo(1920, 1080, 2097152) → "1920 × 1080 · 2.0 MB"', async () => {
  // TC-REQ-FR-MDE-018-AC5-01
  const m = await loadModule();
  assert.equal(m.formatImageInfo(1920, 1080, 2097152), '1920 × 1080 · 2.0 MB');
  // A second input so the formatting cannot be a memorised literal.
  assert.equal(m.formatImageInfo(640, 480, 3145728), '640 × 480 · 3.0 MB');
});

test('소스 가드: ImageFileViewer.tsx 스테이지에 체커보드 배경 클래스가 있고 색은 테마 토큰', () => {
  // TC-REQ-FR-MDE-018-AC6-01
  const source = readViewer();
  const CLASS = 'image-viewer-checkerboard';
  assert.match(source, new RegExp(`className=[^>]*\\b${CLASS}\\b`),
    `the viewer's stage carries the ${CLASS} class`);

  // The class's rule lives in some stylesheet under src/ and paints with theme
  // tokens only -- no colour literal of its own.
  const rules: string[] = [];
  for (const file of listFiles(srcDir, /\.css$/)) {
    const cssText = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rulePattern = new RegExp(`[^{}]*\\.${CLASS}\\b[^{}]*\\{([^}]*)\\}`, 'g');
    let match = rulePattern.exec(cssText);
    while (match !== null) {
      rules.push(match[1]);
      match = rulePattern.exec(cssText);
    }
  }
  assert.ok(rules.length > 0, `a CSS rule for .${CLASS} exists under src/`);
  const body = rules.join('\n');
  assert.match(body, /background[^;]*gradient/, 'the checkerboard is drawn with a gradient background');
  assert.match(body, /var\(--[a-z0-9-]+\)/, 'the checkerboard colours come from theme tokens');
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/,
    'no colour literal in the checkerboard rule');
  assert.doesNotMatch(body, /:\s*[^;]*(?<![-\w])(?:white|black|gray|grey|silver|gainsboro|whitesmoke|lightgray|lightgrey|darkgray|darkgrey|dimgray|dimgrey)\b/i,
    'no named colour in the checkerboard rule');
});

test('describeImageError: FILE_TOO_LARGE·손상(onerror)·거절·FILE_NOT_FOUND 각각 탭 안 문구', async () => {
  // TC-REQ-FR-MDE-018-AC8-01
  const m = await loadModule();
  const tooLarge = m.describeImageError({ kind: 'read', error: new Error('File is too large (FILE_TOO_LARGE)') });
  const missing = m.describeImageError({ kind: 'read', error: new Error('Path not found (PATH_NOT_FOUND)') });
  const rejected = m.describeImageError({ kind: 'read', error: new Error('Invalid input provided (INVALID_INPUT)') });
  const corrupt = m.describeImageError({ kind: 'decode' });

  for (const message of [tooLarge, missing, rejected, corrupt]) {
    assert.equal(typeof message, 'string');
    assert.ok(message.trim().length > 0, 'message is not empty');
  }
  assert.equal(new Set([tooLarge, missing, rejected, corrupt]).size, 4, 'the four reasons read differently');

  // Every other refusal reads as "rejected", including a non-Error throw.
  for (const error of [
    new Error('Path traversal detected (PATH_TRAVERSAL)'),
    new Error('HTTP 403: Forbidden'),
    'network down',
  ]) {
    assert.equal(m.describeImageError({ kind: 'read', error }), rejected);
  }
});

test('소스 가드: ImageFileViewer.tsx 는 <img src={blobUrl}> 로만 그리고 <object>·<iframe>·<embed>·<svg> 삽입이 없다', () => {
  // TC-REQ-SEC-MDE-001-AC1-01
  const source = readViewer();
  const img = jsxElement(source, 'img');
  assert.ok(img !== null, 'the viewer renders an <img>');
  assert.match(img, /\bsrc=\{\s*blobUrl\b/, 'the <img> src is the blob URL');
  assert.doesNotMatch(img, /\bsrc=["'`]/, 'no literal src');

  for (const tag of ['object', 'iframe', 'embed', 'svg']) {
    assert.equal(jsxElement(source, tag), null, `no <${tag}> in the viewer`);
  }
  assert.doesNotMatch(source, /\bsrcDoc\b|\bcreateElement\(\s*['"](?:object|iframe|embed|svg)['"]/,
    'no srcDoc and no element built by hand');
});

test('소스 가드: src/components/editor/ 전체에 innerHTML·dangerouslySetInnerHTML 이 없다', () => {
  // TC-REQ-SEC-MDE-001-AC3-01
  const files = listFiles(editorDir, /\.(ts|tsx)$/);
  assert.ok(files.includes(viewerPath), 'the scan covers ImageFileViewer.tsx');
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML|insertAdjacentHTML)\b/,
      `${relative(srcDir, file)} writes no HTML string into the document`);
  }
});

test('createBlobUrlSlot: replace 는 이전 URL 을 revoke 하고 dispose 는 현재 URL 을 revoke 한다(URL.createObjectURL/revokeObjectURL stub)', async () => {
  // TC-REQ-SEC-MDE-001-AC4-01
  const m = await loadModule();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const created: string[] = [];
  const revoked: string[] = [];
  let next = 0;
  URL.createObjectURL = () => {
    next += 1;
    const url = `blob:test/${next}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  try {
    const slot = m.createBlobUrlSlot();
    assert.equal(slot.current(), null, 'empty before the first image');

    const first = slot.replace(new Blob(['a'], { type: 'image/png' }));
    assert.equal(first, 'blob:test/1');
    assert.equal(slot.current(), first);
    assert.deepEqual(revoked, [], 'nothing revoked yet');

    const second = slot.replace(new Blob(['b'], { type: 'image/svg+xml' }));
    assert.equal(second, 'blob:test/2');
    assert.deepEqual(revoked, [first], 'replace revokes the previous URL');
    assert.equal(slot.current(), second);

    slot.dispose();
    assert.deepEqual(revoked, [first, second], 'dispose revokes the current URL');
    assert.equal(slot.current(), null);

    slot.dispose();
    assert.deepEqual(revoked, [first, second], 'a second dispose revokes nothing more');
    assert.deepEqual(created, [first, second]);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

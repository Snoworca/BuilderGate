// FR-ARCH-016: BuilderGate added to the iPhone home screen opens without Safari's bars.
// Vite copies public/ into the build output unchanged, so the files are read from public/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const publicFile = (path: string) => new URL(`../../public/${path.replace(/^\//, '')}`, import.meta.url);

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function findTag(pattern: RegExp): string | undefined {
  return html.match(pattern)?.[0];
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(publicFile(path));
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('FR-ARCH-016 AC-1: index.html links a standalone manifest with 192 and 512 PNG icons', () => {
  const link = findTag(/<link[^>]*rel="manifest"[^>]*>/);
  assert.ok(link, 'index.html links a manifest');
  const href = attr(link, 'href')!;
  assert.ok(existsSync(publicFile(href)), `${href} is in public/`);
  const manifest = JSON.parse(readFileSync(publicFile(href), 'utf8'));
  assert.equal(manifest.name, 'BuilderGate');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((entry: { sizes: string }) => entry.sizes === `${size}x${size}`);
    assert.ok(icon, `a ${size}x${size} icon is listed`);
    assert.equal(icon.type, 'image/png');
    assert.deepEqual(pngSize(icon.src), { width: size, height: size }, `${icon.src} is ${size}x${size}`);
  }
});

test('FR-ARCH-016 AC-2: index.html declares the iOS home-screen app tags', () => {
  const touchIcon = findTag(/<link[^>]*rel="apple-touch-icon"[^>]*>/);
  assert.ok(touchIcon, 'an apple-touch-icon is declared');
  assert.deepEqual(pngSize(attr(touchIcon, 'href')!), { width: 180, height: 180 });
  const meta = (name: string) => attr(findTag(new RegExp(`<meta[^>]*name="${name}"[^>]*>`)) ?? '', 'content');
  assert.equal(meta('apple-mobile-web-app-capable'), 'yes');
  assert.equal(meta('apple-mobile-web-app-title'), 'BuilderGate');
  assert.ok(meta('apple-mobile-web-app-status-bar-style'), 'a status bar style is set');
});

test('FR-ARCH-016 AC-4: the viewport stays as it was, so tab use is unchanged', () => {
  const viewport = findTag(/<meta[^>]*name="viewport"[^>]*>/);
  assert.equal(
    attr(viewport ?? '', 'content'),
    'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no',
  );
});

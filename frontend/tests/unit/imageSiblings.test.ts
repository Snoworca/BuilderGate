// FR-MDE-027: the image viewer's previous/next list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageDirectoryOf, imageNavigation, imageStepHandlers, listSiblingImages, planImageStep } from '../../src/components/editor/imageSiblings.ts';

const entries = [
  { name: 'b.png', type: 'file' },
  { name: 'notes.md', type: 'file' },
  { name: 'img10.jpg', type: 'file' },
  { name: 'img2.jpg', type: 'file' },
  { name: 'A.svg', type: 'file' },
  { name: 'pics.png', type: 'directory' },
  { name: 'icon.ICO', type: 'file' },
];

test('FR-MDE-027 AC-1: only image files, ordered by name, as absolute paths', () => {
  assert.deepEqual(listSiblingImages('/w/img', entries, 'en'), [
    '/w/img/A.svg', '/w/img/b.png', '/w/img/icon.ICO', '/w/img/img2.jpg', '/w/img/img10.jpg',
  ]);
  assert.deepEqual(listSiblingImages('C:\\w\\img', [{ name: 'x.png', type: 'file' }], 'en'), ['C:\\w\\img\\x.png']);
  assert.deepEqual(listSiblingImages('/', [{ name: 'x.png', type: 'file' }], 'en'), ['/x.png']);
});

test('FR-MDE-027 AC-1: the directory of a POSIX and a Windows path', () => {
  assert.equal(imageDirectoryOf('/w/img/a.png'), '/w/img');
  assert.equal(imageDirectoryOf('/a.png'), '/');
  assert.equal(imageDirectoryOf('C:\\w\\img\\a.png'), 'C:\\w\\img');
  assert.equal(imageDirectoryOf('C:\\a.png'), 'C:\\');
  assert.equal(imageDirectoryOf('/w/odd\\name.png'), '/w', 'a backslash is a POSIX name character');
});

test('FR-MDE-027 AC-2: previous and next, with none past either end', () => {
  const list = ['/d/a.png', '/d/b.png', '/d/c.png'];
  assert.deepEqual(imageNavigation(list, '/d/a.png'), { index: 0, count: 3, previous: null, next: '/d/b.png' });
  assert.deepEqual(imageNavigation(list, '/d/b.png'), { index: 1, count: 3, previous: '/d/a.png', next: '/d/c.png' });
  assert.deepEqual(imageNavigation(list, '/d/c.png'), { index: 2, count: 3, previous: '/d/b.png', next: null });
  assert.deepEqual(imageNavigation(['/d/a.png'], '/d/a.png'), { index: 0, count: 1, previous: null, next: null });
  assert.deepEqual(imageNavigation(list, '/d/z.png'), { index: -1, count: 3, previous: null, next: null });
  assert.equal(imageNavigation(['C:\\D\\A.png', 'C:\\D\\b.png'], 'c:/d/a.png').next, 'C:\\D\\b.png', 'Windows paths ignore case');
});

test('FR-MDE-027 AC-3: a step to an image already open selects it instead of opening it twice', () => {
  const open = ['/d/a.png', '/d/b.png', '/d/notes.md'];
  assert.equal(planImageStep(open, '/d/a.png', '/d/c.png'), 'replace');
  assert.equal(planImageStep(open, '/d/a.png', '/d/b.png'), 'select');
  assert.equal(planImageStep(open, '/d/a.png', '/d/a.png'), 'ignore');
  assert.equal(planImageStep(open, '/d/gone.png', '/d/c.png'), 'ignore', 'the tab was closed meanwhile');
});

test('FR-MDE-027 AC-4: the buttons are disabled at the ends and while an SVG has unsaved changes', () => {
  const steps: string[] = [];
  const place = imageNavigation(['/d/a.svg', '/d/b.svg', '/d/c.svg'], '/d/b.svg');
  const free = imageStepHandlers(place, false, to => steps.push(to));
  free.onPrevious?.();
  free.onNext?.();
  assert.deepEqual(steps, ['/d/a.svg', '/d/c.svg']);
  const locked = imageStepHandlers(place, true, to => steps.push(to));
  assert.equal(locked.onPrevious, null);
  assert.equal(locked.onNext, null);
  const first = imageStepHandlers(imageNavigation(['/d/a.svg', '/d/b.svg'], '/d/a.svg'), false, () => {});
  assert.equal(first.onPrevious, null);
  assert.notEqual(first.onNext, null);
});

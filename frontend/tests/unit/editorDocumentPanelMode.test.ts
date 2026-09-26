import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEditorWindowSaveController } from '../../src/components/editor/editorWindowSave.ts';
import type * as EditorDocumentModeModule from '../../src/components/editor/editorDocumentMode.ts';

// FR-MDE-014 AC-6 / AC-7 / AC-8 -- the document panel draws either the vendored
// markdown editor or the code editor, through one save controller, one handle
// and one set of mount-time props, and the vendor files carry no mode branch.
//
// Contract fixed here for src/components/editor/editorDocumentMode.ts:
//   selectDocumentComponent(kind: EditorModeKind)
//       -> 'markdown' | 'code' | 'image' | null
//     markdown -> the vendored AtomicCodeMirrorEditor
//     code     -> CodeFileEditor
//     image    -> the image viewer's slot (the viewer itself is FR-MDE-018)
//     none     -> null (not an editor document)
//   The module is pure and loads under `node --experimental-strip-types`.
//
// The module is loaded inside the test that needs it: a static import of a
// missing module kills the runner before any test is named. The `import type`
// line is erased at runtime and lets tsc check the call against the real
// signature.
const MODULE_PATH = '../../src/components/editor/editorDocumentMode.ts';
type Mod = typeof EditorDocumentModeModule;

async function loadModule(): Promise<Mod> {
  return await import(MODULE_PATH) as Mod;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const panelPath = resolve(testDir, '../../src/components/editor/EditorDocumentPanel.tsx');
const vendorDir = resolve(testDir, '../../src/editor/vendor/atomic-editor');

function readPanel(): string {
  return readFileSync(panelPath, 'utf8');
}

/**
 * The JSX element opened by `<Name` up to its closing `/>` or `>`. Props are
 * read from this slice only, so a prop on some other element cannot answer for
 * this one. Returns null when the element is not rendered at all.
 */
function jsxElement(source: string, name: string): string | null {
  const start = source.search(new RegExp(`<${name}\\b`));
  if (start < 0) return null;
  // A `>` inside a `{...}` expression (an arrow `=>`, a comparison) does not
  // close the tag, so braces are counted rather than taking the first `>`.
  let depth = 0;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test('코드 모드 문서도 같은 createEditorWindowSaveController 로 save·dirty·닫기 확인을 거친다(소스 가드 + 컨트롤러 단위: code 바인딩의 save 가 writeFile 1회)', async () => {
  // TC-REQ-FR-MDE-014-AC6-01
  const source = readPanel();

  // The panel renders both editors ...
  assert.ok(jsxElement(source, 'AtomicCodeMirrorEditor') !== null, 'panel renders AtomicCodeMirrorEditor');
  const code = jsxElement(source, 'CodeFileEditor');
  assert.ok(code !== null, 'panel renders CodeFileEditor for code-mode documents');

  // ... behind one controller: a second one would be a second save path for
  // Ctrl+S, the title bar button and the close prompt to diverge on.
  const controllerCalls = source.match(/createEditorWindowSaveController\(/g) ?? [];
  assert.equal(controllerCalls.length, 1, 'exactly one save controller is built, for either mode');

  // ... and the window drives either editor through the same handle ref.
  assert.match(code, /editorHandleRef=\{editorHandleRef\}/, 'CodeFileEditor gets the same handle ref');

  // The controller treats a code-mode binding like any other: one press, one write.
  const writes: Array<{ sessionId: string; path: string; content: string }> = [];
  const controller = createEditorWindowSaveController({
    binding: { tabId: 'tab-1', filePath: '/work/src/main.ts' },
    bodyAtOpen: 'const a = 1;\n',
    deps: {
      resolveTabSession: () => 'session-1',
      writeFile: async (sessionId, path, content) => {
        writes.push({ sessionId, path, content });
        return { success: true };
      },
    },
  });
  controller.handleEditorChange('const a = 2;\n');
  assert.equal(controller.isDirty(), true);
  const outcome = await controller.save();
  assert.deepEqual(outcome, { status: 'saved' });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { sessionId: 'session-1', path: '/work/src/main.ts', content: 'const a = 2;\n' });
  assert.equal(controller.isDirty(), false);
});

test('소스 가드: CodeFileEditor 에 documentId={filePath} 와 초기 본문이 editorMountProps 로만 넘어가고 value/onChange controlled prop 이 없다', () => {
  // TC-REQ-FR-MDE-014-AC7-01
  const source = readPanel();

  // The identity is the file path, not the session: a tab restart keeps the file.
  const mountProps = source.match(/const editorMountProps\s*=\s*useMemo\(\s*\(\)\s*=>\s*\(\{([\s\S]*?)\}\)/);
  assert.ok(mountProps !== null, 'editorMountProps is built in one useMemo');
  assert.match(mountProps[1], /documentId:\s*filePath\b/, 'documentId is the file path');

  const code = jsxElement(source, 'CodeFileEditor');
  assert.ok(code !== null, 'panel renders CodeFileEditor');
  assert.match(code, /\{\.\.\.editorMountProps\}/, 'CodeFileEditor takes the shared mount-time props');

  // Restating a mount prop, or adding a controlled one, would feed the body back
  // on a keystroke and break the mount-time contract (FR-MDE-005).
  for (const prop of ['value', 'onChange', 'onMarkdownChange', 'documentId', 'markdownSource']) {
    assert.doesNotMatch(
      code,
      new RegExp(`\\s${prop}=`),
      `CodeFileEditor must not receive ${prop}= outside editorMountProps`,
    );
  }
});

test('소스 가드: src/editor/vendor/atomic-editor/ 아래 파일이 editorMode·CodeFileEditor 를 import 하지 않고 mode 분기가 없다', () => {
  // TC-REQ-FR-MDE-014-AC8-01
  const files = listSourceFiles(vendorDir);
  assert.ok(files.length > 0, 'vendor directory has source files to scan');

  const forbidden: Array<[RegExp, string]> = [
    [/editorMode/, 'editorMode'],
    [/CodeFileEditor/, 'CodeFileEditor'],
    [/editorDocumentMode/, 'editorDocumentMode'],
    [/resolveEditorMode|selectDocumentComponent/, 'mode resolver'],
    [/\b(mode|kind)\s*===?\s*['"](code|markdown|image)['"]/, 'mode branch'],
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(text, pattern, `${relative(vendorDir, file)} carries ${label}`);
    }
  }

  // The branch lives outside the vendor tree: in the panel, through the pure
  // selector and the sibling code editor component.
  const panel = readPanel();
  assert.match(panel, /from '\.\/editorDocumentMode\.ts'/, 'panel imports the mode selector');
  assert.match(panel, /from '\.\/CodeFileEditor(\.tsx)?'/, 'panel imports the separate CodeFileEditor');
});

test('selectDocumentComponent(kind): markdown→Atomic, code→CodeFileEditor, image→ImageFileViewer 자리', async () => {
  // TC-REQ-FR-MDE-014-AC6-02
  const { selectDocumentComponent } = await loadModule();
  assert.equal(typeof selectDocumentComponent, 'function');
  assert.equal(selectDocumentComponent('markdown'), 'markdown');
  assert.equal(selectDocumentComponent('code'), 'code');
  assert.equal(selectDocumentComponent('image'), 'image');
  assert.equal(selectDocumentComponent('none'), null);
});

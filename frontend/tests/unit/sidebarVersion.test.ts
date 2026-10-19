// FR-UIDS-012: the workspace sidebar shows which build is running, so a server
// left on an old dist (start.sh skips the build when dist exists) is visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatBuildLabel } from '../../src/utils/appVersion.ts';

test('FR-UIDS-012 AC-2: v<version> · <commit>, or v<version> alone without a commit', () => {
  assert.equal(formatBuildLabel('0.10.16', '9964d23f'), 'v0.10.16 · 9964d23f');
  assert.equal(formatBuildLabel('0.10.16', ''), 'v0.10.16');
});

test('FR-UIDS-012 AC-1: the build bakes in the version and the short commit, with an empty fallback', () => {
  const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  assert.match(config, /__BUILDERGATE_COMMIT__:\s*JSON\.stringify\(buildCommit\)/u);
  assert.match(config, /git rev-parse --short=8 HEAD/u);
  assert.match(config, /catch\s*\{[^}]*return ''/u);
});

test('FR-UIDS-012 AC-2 AC-3: the sidebar renders the label after the list, with i18n title and aria-label', () => {
  const source = readFileSync(new URL('../../src/components/Workspace/WorkspaceSidebar.tsx', import.meta.url), 'utf8');
  const list = source.indexOf('className="workspace-sidebar-list"');
  const version = source.indexOf('className="workspace-sidebar-version"');
  assert.ok(list > 0 && version > list, 'the version line comes after the list');
  assert.match(source, /title=\{t\('workspace\.sidebar\.version'/u);
  assert.match(source, /aria-label=\{t\('workspace\.sidebar\.version'/u);
  for (const locale of ['en', 'ko']) {
    const catalog = JSON.parse(readFileSync(new URL(`../../public/locales/messages.${locale}.json`, import.meta.url), 'utf8')) as Record<string, string>;
    assert.match(catalog['workspace.sidebar.version'] ?? '', /\{label\}/u, `${locale} has the key`);
  }
});

// FR-UIDS-019 AC-3: the real TerminalView repaints its xterm when the app theme changes,
// without re-creating it, and a terminal opened under the light theme starts light.
//
// xterm itself is faked (it needs a canvas under jsdom). The fake keeps the options
// TerminalView constructs it with and the ones it sets afterwards; xterm repaints from
// those (its ThemeService re-reads options.theme, and a minimumContrastRatio change
// clears the contrast cache). appTheme is wrapped only to count live subscriptions,
// so a closed terminal can be shown to stop listening.
// Runs through test:unit:terminal-view-behavior (tsx + module mocks).
// @req FR-UIDS-019 AC-3
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeAddonClass,
  createFakeTerminalClass,
  renderTerminalView,
  type FakeTerminalState,
  type RenderedTerminalView,
} from './terminalViewHarness.ts';
import * as viewAttributes from '../../src/utils/terminalViewAttributes.ts';

const realAppTheme = await import('../../src/theme/appTheme.ts');
const { applyTheme } = realAppTheme;

const state: FakeTerminalState = {
  selection: '',
  keyHandler: null,
  dataHandler: null,
  writes: [],
  clearSelectionCalls: 0,
  pasted: [],
};

interface RecordedTerminal {
  readonly constructedWith: Record<string, unknown>;
  options: Record<string, unknown>;
}

const created: RecordedTerminal[] = [];
let liveThemeSubscriptions = 0;

{
  const BaseTerminal = createFakeTerminalClass(state);
  class RecordingTerminal extends BaseTerminal {
    readonly constructedWith: Record<string, unknown>;

    constructor(options: Record<string, unknown> = {}) {
      super();
      this.constructedWith = { ...options };
      this.options = { ...options };
      created.push(this);
    }
  }
  const FakeAddon = createFakeAddonClass();
  mock.module('@xterm/xterm', { namedExports: { Terminal: RecordingTerminal } });
  mock.module('@xterm/addon-fit', { namedExports: { FitAddon: FakeAddon } });
  mock.module('@xterm/addon-serialize', { namedExports: { SerializeAddon: FakeAddon } });
  mock.module('@xterm/addon-webgl', { namedExports: { WebglAddon: FakeAddon } });
  mock.module('@xterm/addon-unicode11', { namedExports: { Unicode11Addon: FakeAddon } });
  mock.module('../../src/theme/appTheme.ts', {
    namedExports: {
      ...realAppTheme,
      subscribeAppliedTheme: (...args: Parameters<typeof realAppTheme.subscribeAppliedTheme>) => {
        const stop = realAppTheme.subscribeAppliedTheme(...args);
        liveThemeSubscriptions += 1;
        let stopped = false;
        return () => {
          if (!stopped) {
            stopped = true;
            liveThemeSubscriptions -= 1;
          }
          stop();
        };
      },
    },
  });
  mock.module('../../src/contexts/WebSocketContext.tsx', {
    namedExports: {
      useWebSocketActions: () => ({
        send: () => ({ ok: true as const }),
        registerTerminalCheckpointDispatcher: () => () => {},
        refreshTerminalCheckpointRegistration: () => {},
        registerTerminalResponderHandoffView: () => () => {},
        registerTerminalResponderHandoffRuntime: () => () => {},
        getTerminalControlSocketReceipt: () => null,
        sendTerminalAuthorityControl: () => ({ ok: true as const }),
      }),
      useWebSocketState: () => ({ connected: true }),
    },
  });
}

// A mounted TerminalView keeps timers alive; whatever a failing test left mounted is
// unmounted here so the process can exit.
const mounted = new Set<RenderedTerminalView>();

async function render(): Promise<RenderedTerminalView> {
  const view = await renderTerminalView({ state });
  mounted.add(view);
  return view;
}

async function unmount(view: RenderedTerminalView): Promise<void> {
  if (!mounted.delete(view)) return;
  await view.unmount();
}

test.afterEach(async () => {
  for (const view of [...mounted]) await unmount(view);
  created.length = 0;
  applyTheme('dark');
});

const DARK = viewAttributes.TERMINAL_XTERM_THEME;

function lightPalette() {
  const theme = viewAttributes.TERMINAL_XTERM_LIGHT_THEME;
  assert.ok(theme, 'terminalViewAttributes exports TERMINAL_XTERM_LIGHT_THEME');
  return theme;
}

test('FR-UIDS-019 AC-3: a terminal opened under the light theme starts with the light palette and contrast help', async () => {
  applyTheme('light');
  await render();
  assert.equal(created.length, 1);
  assert.equal(created[0].constructedWith.theme, lightPalette());
  assert.equal(created[0].constructedWith.minimumContrastRatio, 4.5);
});

test('FR-UIDS-019 AC-2: a terminal opened under the dark theme starts with the dark palette, contrast at the xterm default', async () => {
  applyTheme('dark');
  await render();
  assert.equal(created.length, 1);
  assert.equal(created[0].constructedWith.theme, DARK);
  // Unset before FR-UIDS-019, which is xterm's default of 1.
  assert.equal(created[0].constructedWith.minimumContrastRatio ?? 1, 1);
});

test('FR-UIDS-019 AC-3: switching the theme repaints every open terminal in place', async () => {
  applyTheme('dark');
  await render();
  await render();
  assert.equal(created.length, 2, 'two open terminals; a tab and a grid tile both render TerminalView');
  for (const term of created) assert.equal(term.options.theme, DARK);

  applyTheme('light');
  for (const term of created) {
    assert.equal(term.options.theme, lightPalette());
    assert.equal(term.options.minimumContrastRatio, 4.5);
  }

  applyTheme('dark');
  for (const term of created) {
    assert.equal(term.options.theme, DARK);
    assert.equal(term.options.minimumContrastRatio, 1, "back to xterm's default");
  }
  assert.equal(created.length, 2, 'repainted, not re-created');
});

test('FR-UIDS-019 AC-3: a closed terminal stops following the theme', async () => {
  applyTheme('dark');
  const view = await render();
  assert.equal(liveThemeSubscriptions, 1, 'an open terminal follows the theme');
  const [term] = created;
  await unmount(view);
  assert.equal(liveThemeSubscriptions, 0, 'closing it lets go of the subscription');
  applyTheme('light');
  assert.equal(term.options.theme, DARK, 'and the closed xterm is left alone');
});

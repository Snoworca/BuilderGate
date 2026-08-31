import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  analyzeTerminalSoleWriterSources,
  collectTerminalSoleWriterInventory,
} from '../support/terminalSoleWriterInventory.ts';

const FRONTEND_ROOT = resolve(import.meta.dirname, '../..');

test('FR-BGSTAB-022 AST inventory detects aliases, destructuring, and bracket raw mutations', () => {
  const inventory = analyzeTerminalSoleWriterSources({
    frontendRoot: FRONTEND_ROOT,
    sources: {
      'src/fixture.ts': `
        import { Terminal as XtermRuntime } from '@xterm/xterm';
        import { FitAddon as Resizer } from '@xterm/addon-fit';

        declare const receiver: XtermRuntime;
        const terminalAlias = receiver;
        terminalAlias['write']('direct bracket');
        const { reset: wipe } = terminalAlias;
        wipe();
        const resizeAlias = terminalAlias.resize;
        resizeAlias(120, 40);
        terminalAlias["clear"]();
        const optionAlias = terminalAlias.options;
        optionAlias['windowsPty'] = { backend: 'conpty' };

        const fitReceiver: Resizer = new Resizer();
        const { fit: applyFit } = fitReceiver;
        applyFit();
      `,
    },
  });

  assert.deepEqual(
    inventory.rawMutationFindings.map(finding => finding.operation).sort(),
    [
      'fitAddon.fit',
      'terminal.clear',
      'terminal.options.windowsPty',
      'terminal.reset',
      'terminal.resize',
      'terminal.write',
    ].sort(),
  );
});

test('FR-BGSTAB-022 AST inventory rejects production imports of the raw adapter outside coordinator', () => {
  const inventory = analyzeTerminalSoleWriterSources({
    frontendRoot: FRONTEND_ROOT,
    sources: {
      'src/utils/terminalWriteCoordinatorRuntime.ts': `
        import { createTerminalRawMutationAdapter } from './terminalRawMutationAdapter.ts';
        void createTerminalRawMutationAdapter;
      `,
      'src/utils/terminalWriteCoordinator.ts': `
        export const createTerminalWriteCoordinator = () => undefined;
      `,
      'src/components/Rogue.ts': `
        import { createTerminalRawMutationAdapter as bypass } from '../utils/terminalRawMutationAdapter';
        void bypass;
      `,
      'src/components/Reexport.ts': `
        export { createTerminalRawMutationAdapter } from '../utils/terminalRawMutationAdapter.ts';
      `,
      'src/components/Dynamic.ts': `
        export const loadBypass = () => import('../utils/terminalRawMutationAdapter.ts');
      `,
      'src/utils/terminalRawMutationAdapter.ts': `
        export const createTerminalRawMutationAdapter = () => undefined;
      `,
    },
  });

  assert.deepEqual(
    inventory.rawAdapterImportFindings.map(finding => finding.file).sort(),
    ['src/components/Dynamic.ts', 'src/components/Reexport.ts', 'src/components/Rogue.ts'],
  );
});

test('FR-BGSTAB-022 production inventory has one adapter boundary and no raw mutation bypass', () => {
  const inventory = collectTerminalSoleWriterInventory(FRONTEND_ROOT);

  assert.deepEqual(inventory.rawMutationFindings, []);
  assert.deepEqual(inventory.rawAdapterImportFindings, []);
  assert.deepEqual(
    inventory.adapterOperations.filter(operation => !operation.present),
    [],
  );
});

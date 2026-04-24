const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_NAME = 'react-mosaic-component';
const PACKAGE_DIR = path.join(ROOT, 'node_modules', PACKAGE_NAME);

const requiredSnippets = [
  {
    file: path.join(PACKAGE_DIR, 'lib', 'Mosaic.d.ts'),
    text: 'reorderEnabled?: boolean;',
  },
  {
    file: path.join(PACKAGE_DIR, 'lib', 'Mosaic.js'),
    text: 'reorderEnabled: !!this.props.reorderEnabled',
  },
  {
    file: path.join(PACKAGE_DIR, 'lib', 'MosaicDropTarget.js'),
    text: "kind: 'reorder'",
  },
  {
    file: path.join(PACKAGE_DIR, 'lib', 'MosaicWindow.js'),
    text: 'reorder-enabled',
  },
];

function hasRequiredPatch() {
  return requiredSnippets.every(({ file, text }) => {
    if (!fs.existsSync(file)) {
      return false;
    }
    return fs.readFileSync(file, 'utf8').includes(text);
  });
}

function getPatchPackageBin() {
  return path.join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'patch-package.cmd' : 'patch-package',
  );
}

function applyPatch() {
  const patchPackageBin = getPatchPackageBin();
  if (!fs.existsSync(patchPackageBin)) {
    throw new Error('patch-package executable is missing. Run npm install in frontend first.');
  }

  const result = spawnSync(patchPackageBin, [PACKAGE_NAME], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`patch-package failed with exit code ${result.status}`);
  }
}

try {
  if (!fs.existsSync(PACKAGE_DIR)) {
    throw new Error(`${PACKAGE_NAME} is not installed. Run npm install in frontend first.`);
  }

  if (hasRequiredPatch()) {
    console.log('[prebuild] react-mosaic-component patch already applied.');
    process.exit(0);
  }

  console.log('[prebuild] Applying react-mosaic-component patch...');
  applyPatch();

  if (!hasRequiredPatch()) {
    throw new Error('react-mosaic-component patch did not produce the required reorder support.');
  }

  console.log('[prebuild] react-mosaic-component patch applied.');
} catch (error) {
  console.error('[prebuild] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}

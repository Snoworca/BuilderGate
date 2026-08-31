const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE_PTY_DIR = path.join(ROOT, 'node_modules', 'node-pty');

const patches = [
  {
    label: 'node-pty ConPTY console-list helper',
    file: path.join(NODE_PTY_DIR, 'lib', 'windowsPtyAgent.js'),
    before: "child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()])",
    after: "child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()], { windowsHide: true })",
  },
  {
    label: 'node-pty ConPTY console-list attach fallback',
    file: path.join(NODE_PTY_DIR, 'lib', 'conpty_console_list_agent.js'),
    before: 'var consoleProcessList = getConsoleProcessList(shellPid);\nprocess.send({ consoleProcessList: consoleProcessList });',
    after: 'var consoleProcessList;\ntry {\n    consoleProcessList = getConsoleProcessList(shellPid);\n}\ncatch (_a) {\n    consoleProcessList = [shellPid];\n}\nprocess.send({ consoleProcessList: consoleProcessList });',
  },
  {
    label: 'node-pty ConPTY natural-exit input pipe cleanup',
    file: path.join(NODE_PTY_DIR, 'lib', 'windowsPtyAgent.js'),
    before: 'this._inSocket.readable = false;\n        this._outSocket.readable = false;\n        this._outSocket.destroy();',
    after: "this._inSocket.readable = false;\n        this._outSocket.readable = false;\n        this._inSocket.on('error', function () { });\n        this._inSocket.destroy();\n        this._outSocket.destroy();",
  },
];

function ensurePatch(options = {}) {
  const log = options.log ?? console.log;
  const patchList = options.patches ?? patches;
  let changed = false;

  for (const patch of patchList) {
    if (!fs.existsSync(patch.file)) {
      throw new Error(`${patch.label} target is missing: ${patch.file}`);
    }

    const original = fs.readFileSync(patch.file, 'utf8');
    if (original.includes(patch.after)) {
      continue;
    }
    if (!original.includes(patch.before)) {
      throw new Error(`${patch.label} patch target did not match expected node-pty source: ${patch.file}`);
    }

    fs.writeFileSync(patch.file, original.replace(patch.before, patch.after), 'utf8');
    changed = true;
  }

  log(changed
    ? '[prebuild] node-pty Windows runtime patches applied.'
    : '[prebuild] node-pty Windows runtime patches already applied.');
  return changed;
}

if (require.main === module) {
  try {
    ensurePatch();
  } catch (error) {
    console.error('[prebuild] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  ensurePatch,
  patches,
};

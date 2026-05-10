const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const source = path.join(root, 'frontend', 'dist');
const targetRoot = path.join(root, 'server', 'dist');
const target = path.join(targetRoot, 'public');

if (!fs.existsSync(source) || !fs.existsSync(targetRoot)) {
  process.exit(0);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });

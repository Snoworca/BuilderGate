const { spawnSync } = require('child_process');

const APP_NAME = 'projectmaster';

function getPm2Command() {
  return process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? __dirname,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    shell: process.platform === 'win32',
    encoding: options.captureOutput ? 'utf8' : undefined,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const label = options.label ?? `${command} ${args.join(' ')}`;
    throw new Error(`${label} failed with exit code ${result.status}`);
  }

  return result;
}

function isPm2Installed() {
  try {
    runCommand(getPm2Command(), ['-v'], {
      stdio: 'ignore',
      label: 'pm2 version check',
    });
    return true;
  } catch {
    return false;
  }
}

function getPm2ProcessList() {
  const result = runCommand(getPm2Command(), ['jlist'], {
    captureOutput: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    label: 'pm2 jlist',
  });

  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    return [];
  }

  return JSON.parse(stdout);
}

function main() {
  if (!isPm2Installed()) {
    console.log('[stop] pm2 is not installed. Nothing to stop.');
    return;
  }

  const hasApp = getPm2ProcessList().some((app) => app.name === APP_NAME);
  if (!hasApp) {
    console.log(`[stop] pm2 app "${APP_NAME}" is not running.`);
    return;
  }

  runCommand(getPm2Command(), ['stop', APP_NAME], {
    label: `pm2 stop ${APP_NAME}`,
  });
  runCommand(getPm2Command(), ['delete', APP_NAME], {
    label: `pm2 delete ${APP_NAME}`,
  });

  console.log(`[stop] pm2 app "${APP_NAME}" stopped and removed.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[stop] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

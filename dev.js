const { spawn } = require('child_process');
const path = require('path');

const ROOT = __dirname;
const children = [];

// --- Port configuration ---
function parseArgs() {
  const args = process.argv.slice(2);
  let serverPort = 4242;
  let frontendPort = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      serverPort = parseInt(args[++i], 10);
    } else if (args[i] === '--fport' && args[i + 1]) {
      frontendPort = parseInt(args[++i], 10);
    }
  }

  if (frontendPort === null) {
    frontendPort = serverPort + 303;
  }

  for (const [name, port] of [['--port', serverPort], ['--fport', frontendPort]]) {
    if (isNaN(port) || port < 1024 || port > 65535) {
      console.error(`Error: ${name} must be between 1024 and 65535 (got: ${port})`);
      process.exit(1);
    }
  }
  if (serverPort === frontendPort) {
    console.error(`Error: server port and frontend port must differ (both are ${serverPort})`);
    process.exit(1);
  }

  return { serverPort, frontendPort };
}

const { serverPort, frontendPort } = parseArgs();

function prefix(name, color) {
  const colors = { cyan: '\x1b[36m', magenta: '\x1b[35m', reset: '\x1b[0m' };
  const c = colors[color] || colors.reset;
  return (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        process.stdout.write(`${c}[${name}]${colors.reset} ${line}\n`);
      }
    }
  };
}

function cleanup() {
  console.log('\nShutting down...');
  for (const child of children) {
    if (!child.killed) {
      // Windows: shell:true 로 생성된 자식 프로세스 트리 종료
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', child.pid.toString(), '/T', '/F'], { shell: true });
      } else {
        child.kill();
      }
    }
  }
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

// 1. Start server
console.log('Starting server...');
const server = spawn('npm', ['run', 'dev'], {
  cwd: path.join(ROOT, 'server'),
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(serverPort), DEV_FRONTEND_PORT: String(frontendPort) },
});
children.push(server);

server.stdout.on('data', prefix('server', 'cyan'));
server.stderr.on('data', prefix('server', 'cyan'));

server.on('close', (code) => {
  console.log(`[server] exited with code ${code}`);
});

// 2. Wait 3s then start frontend (Vite dev server with HMR)
setTimeout(() => {
  console.log('Starting frontend (Vite dev server with HMR)...');
  console.log(`Open https://localhost:${serverPort} in your browser`);
  const frontend = spawn('npx', ['vite', '--host'], {
    cwd: path.join(ROOT, 'frontend'),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1', DEV_SERVER_PORT: String(serverPort), DEV_FRONTEND_PORT: String(frontendPort) },
  });
  children.push(frontend);

  frontend.stdout.on('data', prefix('frontend', 'magenta'));
  frontend.stderr.on('data', prefix('frontend', 'magenta'));

  frontend.on('close', (code) => {
    console.log(`[frontend] exited with code ${code}`);
  });
}, 3000);

const { resolveRuntimePaths } = require('./tools/daemon/runtime-paths');
const { stopDaemon } = require('./tools/daemon/stop-client');

async function main(options = {}) {
  const paths = options.paths ?? resolveRuntimePaths();
  const result = await stopDaemon(paths, options);

  if (result.message) {
    const log = result.exitCode === 0 ? console.log : console.error;
    log(result.message);
  }

  return result.exitCode;
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    console.error('[stop] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  main,
};

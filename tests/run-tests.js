/* Runs the full ChatKro test suite against a fresh server instance on a dedicated port. */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = process.env.TEST_PORT || 8099;
const ROOT = path.join(__dirname, '..');

function waitForServer(port, tries) {
  return new Promise((resolve, reject) => {
    const probe = () => {
      http.get('http://localhost:' + port, (res) => { res.resume(); resolve(); })
        .on('error', () => { if (--tries <= 0) return reject(new Error('server did not start')); setTimeout(probe, 300); });
    };
    probe();
  });
}

function run(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', name)], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(name + ' exited ' + code))));
  });
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  try {
    await waitForServer(PORT, 20);
    await run('e2e-test.js');
    await run('client-test.js');
    console.log('\nALL SUITES PASSED.');
    process.exit(0);
  } catch (err) {
    console.error('\nTEST FAILURE: ' + err.message);
    process.exit(1);
  } finally {
    server.kill();
  }
})();

/* ChatKro public launcher: starts the server, then opens a public HTTPS tunnel
   using ngrok or cloudflared if installed. Prints all access URLs. */
const { spawn, exec } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8080;
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k in ifs) {
    for (const a of ifs[k] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function findBin(name) {
  return new Promise((resolve) => {
    exec('where ' + name, (err, stdout) => {
      if (err) return resolve(null);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const preferred = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0];
      resolve(preferred || null);
    });
  });
}

function guardedSpawn(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  child.on('error', () => {});
  children.push(child);
  return child;
}

function realBin(bin, versionArg) {
  return new Promise((resolve) => {
    exec(JSON.stringify(bin) + ' ' + versionArg, { timeout: 5000 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      resolve(err ? null : out);
    });
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  });
  child.on('error', () => {});
  children.push(child);
  return child;
}

function waitForServer(child, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    child.once('exit', () => resolve(false));
    const tryOnce = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (Date.now() > deadline) return resolve(false);
      const req = http.get('http://127.0.0.1:' + PORT, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
        res.on('end', () => resolve(body.indexOf('RANDOMEET') !== -1));
      });
      req.on('error', () => setTimeout(tryOnce, 400));
    };
    tryOnce();
  });
}

async function startNgrok() {
  const bin = await findBin('ngrok');
  if (!bin) return null;
  const ver = await realBin(bin, 'version');
  if (!ver) {
    console.log('> ngrok found but it is not the real binary (npm wrapper?). Skipping. Get it from https://ngrok.com/download');
    return null;
  }
  console.log('> Detected ngrok, opening public tunnel...');
  const child = guardedSpawn(bin, ['http', String(PORT)], { shell: true, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const body = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(d));
        }).on('error', reject);
      });
      const json = JSON.parse(body);
      const tunnel = (json.tunnels || []).find((t) => t.public_url && t.public_url.startsWith('https'));
      if (tunnel) return tunnel.public_url;
    } catch {}
  }
  console.log('> ngrok did not produce a tunnel (missing authtoken?). Run: ngrok authtoken <your-token>');
  child.kill();
  return null;
}

async function startCloudflared() {
  const bin = await findBin('cloudflared');
  if (!bin) return null;
  const ver = await realBin(bin, '--version');
  if (!ver) {
    console.log('> cloudflared found but does not run. Get it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    return null;
  }
  console.log('> Detected cloudflared, opening public tunnel...');
  const child = guardedSpawn(bin, ['tunnel', '--url', 'http://localhost:' + PORT], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) return m[0];
  }
  child.kill();
  return null;
}

(async () => {
  console.log('\n==========================================');
  console.log('  CHATKRO PUBLIC LAUNCHER');
  console.log('==========================================');
  const child = startServer();
  const up = await waitForServer(child, 15000);
  if (!up) {
    console.error('\n> SERVER FAILED TO START.');
    console.error('> Port ' + PORT + ' may already be in use, or server.js has an error.');
    console.error('> Try a different port:  set PORT=8090  then run  node start.js');
    process.exit(1);
  }
  console.log('> Server confirmed up on http://localhost:' + PORT);
  await sleep(500);

  let publicUrl = (await startNgrok()) || (await startCloudflared());

  console.log('\n==========================================');
  console.log('  ACCESS CHATKRO FROM ANYWHERE:');
  if (publicUrl) console.log('  PUBLIC  (anyone, worldwide): ' + publicUrl);
  else console.log('  PUBLIC  (none - install ngrok or cloudflared, or deploy elsewhere)');
  console.log('  LOCAL   (this machine):      http://localhost:' + PORT);
  for (const ip of lanIPs()) console.log('  LAN     (same wifi):         http://' + ip + ':' + PORT);
  console.log('==========================================');
  console.log('  Camera requires HTTPS - use the PUBLIC url for video calls.');
  console.log('  Press Ctrl+C to stop. TURN relay is included (free 20GB/mo).');
  console.log('==========================================\n');
})().catch((err) => {
  console.error('Launcher error:', err);
  process.exit(1);
});

process.on('exit', () => children.forEach((c) => { try { c.kill(); } catch {} }));
process.on('SIGINT', () => { children.forEach((c) => { try { c.kill(); } catch {} }); process.exit(0); });

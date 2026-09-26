/* =========================================================================
   TORQ — PHONE -> WebSocket -> PC -> GAME

       node bridge.js

   One process does three jobs:
     1. Serves the app over HTTPS (phones refuse motion sensors otherwise).
     2. Accepts a WebSocket on the SAME port, so the phone connects to
        wss://<same host> and reuses the certificate it already trusted.
     3. Pipes steering values into input_driver.py, which emits real
        Windows input events that games accept.

   No npm packages. The WebSocket handshake and framing are implemented
   below against RFC 6455 directly.

   Flags:
     --no-input       serve only, do not launch the input driver
     --keys ad        use A / D instead of the arrow keys
     --mode keyboard  force keyboard even if vgamepad is installed
     --throttle up    hold this key down while driving
     --deadzone 6     ignore values smaller than this
   ========================================================================= */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const ROOT = __dirname;
const CERT_DIR = path.join(ROOT, '.certs');
const KEY = path.join(CERT_DIR, 'key.pem');
const CRT = path.join(CERT_DIR, 'cert.pem');
const PORT = Number(process.env.PORT) || 8443;

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
}
const NO_INPUT = argv.includes('--no-input');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

/* ---------------------------------------------------------------- network */

function lanAddress() {
  const nets = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !/^169\.254\./.test(net.address)) {
        all.push({ name, address: net.address });
      }
    }
  }
  const chosen = all.find(c => /^192\.168\./.test(c.address)) ||
                 all.find(c => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) ||
                 all.find(c => /^10\./.test(c.address)) || all[0];
  return { chosen: chosen ? chosen.address : '127.0.0.1', all };
}

function findOpenssl() {
  const guesses = ['openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe', '/usr/bin/openssl'];
  for (const g of guesses) {
    try { execFileSync(g, ['version'], { stdio: 'ignore' }); return g; } catch (e) {}
  }
  return null;
}

function ensureCert(ip) {
  if (fs.existsSync(KEY) && fs.existsSync(CRT)) return true;
  const openssl = findOpenssl();
  if (!openssl) {
    console.error('\n  No openssl found - falling back to HTTP. Motion sensors will NOT work.\n');
    return false;
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  console.log('  Generating a self-signed certificate for ' + ip + ' ...');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY, '-out', CRT, '-days', '825', '-subj', '/CN=' + ip,
    '-addext', 'subjectAltName=IP:' + ip + ',IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  return true;
}

/* ----------------------------------------------------------- static files */

function handler(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------- WebSocket (RFC 6455) */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(data, opcode) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | (opcode || 0x1);
  return Buffer.concat([header, payload]);
}

/** Returns one decoded frame, or null when more bytes are still needed. */
function parseFrame(b) {
  if (b.length < 2) return null;
  const opcode = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  let mask = null;
  if (masked) { if (b.length < off + 4) return null; mask = b.subarray(off, off + 4); off += 4; }
  if (b.length < off + len) return null;
  let payload = Buffer.from(b.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, total: off + len };
}

let clients = new Set();
let lastValue = 0;
let packets = 0;
let lastPacketAt = 0;
let centred = true;

function attachWebSocket(server) {
  server.on('upgrade', (req, socket) => {
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                 'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');

    socket.setNoDelay(true);
    clients.add(socket);
    console.log('\n  Phone connected (' + req.socket.remoteAddress + ')');
    try {
      socket.write(encodeFrame(JSON.stringify({ t: 'hello', driver: driverName, mode: driverMode })));
    } catch (e) {}

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      let f;
      while ((f = parseFrame(buf))) {
        buf = buf.subarray(f.total);
        if (f.opcode === 0x8) { socket.end(); return; }
        if (f.opcode === 0x9) { socket.write(encodeFrame(f.payload, 0xA)); continue; }
        if (f.opcode === 0x1) onMessage(f.payload.toString('utf8'));
      }
    });

    const drop = () => {
      if (!clients.has(socket)) return;
      clients.delete(socket);
      console.log('\n  Phone disconnected');
      if (clients.size === 0) release();
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });
}

function onMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }

  if (msg.t === 'steer' && typeof msg.v === 'number') {
    lastValue = Math.max(-100, Math.min(100, msg.v));
    packets++;
    lastPacketAt = Date.now();
    centred = false;
    feed(lastValue.toFixed(2));
  } else if (msg.t === 'throttle') {
    feed(msg.on ? 'THROTTLE ON' : 'THROTTLE OFF');
  } else if (msg.t === 'release') {
    release();
  } else if (msg.t === 'mode') {
    switchDriver(String(msg.mode || ''));
  }
}

/* --------------------------------------------------------- input driver */

let driver = null;
let driverName = 'none';
let driverMode = String(flag('mode', 'auto'));

function feed(line) {
  if (driver && driver.stdin.writable) {
    try { driver.stdin.write(line + '\n'); } catch (e) {}
  }
}
function release() { feed('RELEASE'); centred = true; }

/**
 * Dead-man's switch.
 *
 * A phone can stop sending without the socket closing — screen lock, tab
 * backgrounded, Wi-Fi stall. Without this the PC keeps acting on the last
 * value forever: a key held down, or the stick pinned at full lock. Centre
 * the output if nothing has arrived recently.
 */
const STALE_MS = 500;
setInterval(() => {
  if (centred || !clients.size) return;
  if (Date.now() - lastPacketAt > STALE_MS) {
    release();
    console.log('\n  Input went quiet - steering centred for safety');
  }
}, 120);

/** Tell every connected phone what the PC side is doing. */
function broadcast(obj) {
  let frame;
  try { frame = encodeFrame(JSON.stringify(obj)); } catch (e) { return; }
  clients.forEach(s => { try { s.write(frame); } catch (e) {} });
}

function startDriver(mode) {
  if (NO_INPUT) { console.log('  Input driver disabled (--no-input)'); return; }

  const script = path.join(ROOT, 'input_driver.py');
  if (!fs.existsSync(script)) { console.log('  input_driver.py missing - serving only'); return; }

  driverMode = mode || driverMode;

  const args = ['-u', script,
    '--keys', String(flag('keys', 'arrows')),
    '--mode', driverMode,
    '--deadzone', String(flag('deadzone', '4'))];
  const th = flag('throttle', '');
  if (th && th !== true) args.push('--throttle', String(th));
  if (argv.includes('--dry-run')) args.push('--dry-run');

  const exe = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  driver = child;

  child.stdout.on('data', d => {
    String(d).trim().split('\n').forEach(line => {
      if (line.startsWith('READY|')) {
        // READY|<effective mode>|<description> — 'auto' resolves to whatever
        // actually loaded, so the phone can show the real backend.
        const parts = line.split('|');
        driverMode = parts[1] || driverMode;
        driverName = parts[2] || 'unknown';
        console.log('\n  Input driver: ' + driverName);
        broadcast({ t: 'hello', driver: driverName, mode: driverMode });
      } else if (line.trim()) {
        console.log('  [driver] ' + line.trim());
      }
    });
  });
  child.stderr.on('data', d => console.error('  [driver err] ' + String(d).trim()));
  child.on('error', e => {
    console.error('\n  Could not start Python (' + e.message + ').');
    console.error('  The app will still work, but nothing will reach your game.\n');
    if (driver === child) { driver = null; driverName = 'unavailable'; }
    broadcast({ t: 'hello', driver: 'unavailable', mode: driverMode });
  });
  child.on('exit', c => {
    if (driver === child) driver = null;
    if (c) console.log('  Input driver exited (' + c + ')');
  });
}

/** Shut the current driver down cleanly, then run `next`. */
function stopDriver(next) {
  const child = driver;
  if (!child) { next && next(); return; }
  driver = null;
  driverName = 'switching…';

  let done = false;
  const finish = () => { if (done) return; done = true; next && next(); };

  child.once('exit', finish);
  try { child.stdin.write('RELEASE\nQUIT\n'); child.stdin.end(); } catch (e) {}
  // Don't wait forever if Python is wedged.
  setTimeout(() => { try { child.kill(); } catch (e) {} finish(); }, 1500);
}

/** Phone asked for a different input backend. */
function switchDriver(mode) {
  if (!['auto', 'keyboard', 'gamepad', 'browser'].includes(mode)) return;
  if (mode === driverMode && driver) {
    broadcast({ t: 'hello', driver: driverName, mode: driverMode });
    return;
  }
  console.log('\n  Switching input mode -> ' + mode);
  broadcast({ t: 'hello', driver: 'switching…', mode: mode });
  driverMode = mode;
  stopDriver(() => startDriver(mode));
}

/* ------------------------------------------------------------------ boot */

const { chosen, all } = lanAddress();
const secure = ensureCert(chosen);
const server = secure
  ? https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) }, handler)
  : http.createServer(handler);

attachWebSocket(server);
startDriver(driverMode);

server.listen(PORT, '0.0.0.0', () => {
  const scheme = secure ? 'https' : 'http';
  console.log('\n  ===========================================');
  console.log('   T O R Q   ->  WebSocket  ->  GAME');
  console.log('  ===========================================\n');
  console.log('  Open on your phone :  ' + scheme + '://' + chosen + ':' + PORT);
  console.log('  On this computer   :  ' + scheme + '://localhost:' + PORT + '\n');
  if (all.length > 1) {
    console.log('  Other addresses to try:');
    all.forEach(c => console.log('    ' + scheme + '://' + c.address + ':' + PORT + '   (' + c.name + ')'));
    console.log('');
  }
  console.log('  Accept the certificate warning on the phone, then tap Get Started.');
  console.log('  Focus your game window - input goes to whatever window is active.\n');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('\n  Port ' + PORT + ' is busy. Try:  set PORT=8444 && node bridge.js\n');
  else console.error(e);
});

/* live readout */
let spinner = 0;
setInterval(() => {
  if (clients.size === 0) return;
  const v = Math.round(lastValue);
  const width = 31, mid = (width - 1) / 2;
  const pos = Math.round(mid + (v / 100) * mid);
  let bar = '';
  for (let i = 0; i < width; i++) bar += i === pos ? '#' : (i === mid ? '|' : '-');
  const label = (v > 0 ? '+' : '') + v;
  process.stdout.write('\r  [' + bar + '] ' + label.padStart(4) + '   ' + packets + ' pkt ' + '|/-\\'[spinner++ % 4] + ' ');
}, 100);

function shutdown() {
  console.log('\n  Shutting down...');
  release();
  if (driver) { feed('QUIT'); try { driver.stdin.end(); } catch (e) {} }
  setTimeout(() => process.exit(0), 250);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

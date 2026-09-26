/* =========================================================================
   Tiny HTTPS dev server for TORQ.

       node serve.js

   Why HTTPS? iOS Safari and Android Chrome both refuse to hand out motion
   sensor data on an insecure origin, so a plain http:// LAN address will
   never work. This serves the folder over TLS with a self-signed
   certificate and prints the address to open on your phone.

   The certificate is generated once into .certs/ using openssl. It is
   self-signed, so your phone will warn you the first time — that is
   expected, and you can safely continue for your own machine.
   ========================================================================= */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const CERT_DIR = path.join(ROOT, '.certs');
const KEY = path.join(CERT_DIR, 'key.pem');
const CRT = path.join(CERT_DIR, 'cert.pem');
const PORT = Number(process.env.PORT) || 8443;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** First non-internal IPv4 address — the one your phone can reach. */
function lanAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push({ name, address: net.address });
    }
  }
  // Prefer a normal private LAN range over virtual adapters (WSL, Docker, VPN).
  const preferred = candidates.find(c => /^192\.168\./.test(c.address)) ||
                    candidates.find(c => /^10\./.test(c.address)) ||
                    candidates[0];
  return { chosen: preferred ? preferred.address : '127.0.0.1', all: candidates };
}

function findOpenssl() {
  const guesses = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    '/usr/bin/openssl'
  ];
  for (const g of guesses) {
    try { execFileSync(g, ['version'], { stdio: 'ignore' }); return g; }
    catch (e) { /* try the next one */ }
  }
  return null;
}

function ensureCert(ip) {
  if (fs.existsSync(KEY) && fs.existsSync(CRT)) return true;

  const openssl = findOpenssl();
  if (!openssl) {
    console.error('\n  Could not find openssl, so no HTTPS certificate can be made.');
    console.error('  On Windows it ships with Git for Windows.');
    console.error('  Falling back to plain HTTP — motion sensors will NOT work.\n');
    return false;
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  console.log('  Generating a self-signed certificate for ' + ip + ' ...');
  execFileSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY, '-out', CRT, '-days', '825',
    '-subj', '/CN=' + ip,
    '-addext', 'subjectAltName=IP:' + ip + ',IP:127.0.0.1,DNS:localhost'
  ], { stdio: 'ignore' });
  return true;
}

function handler(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  // Keep the server inside this folder.
  const full = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

const { chosen, all } = lanAddress();
const secure = ensureCert(chosen);

const server = secure
  ? https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) }, handler)
  : http.createServer(handler);

server.listen(PORT, '0.0.0.0', () => {
  const scheme = secure ? 'https' : 'http';
  console.log('\n  TORQ is serving ' + ROOT);
  console.log('\n  On this computer :  ' + scheme + '://localhost:' + PORT);
  console.log('  On your phone    :  ' + scheme + '://' + chosen + ':' + PORT + '\n');
  if (all.length > 1) {
    console.log('  Other addresses on this machine (try these if the one above fails):');
    all.forEach(c => console.log('    ' + scheme + '://' + c.address + ':' + PORT + '   (' + c.name + ')'));
    console.log('');
  }
  if (secure) {
    console.log('  The certificate is self-signed, so your phone will show a warning');
    console.log('  the first time. Choose "Advanced" then "Continue" / "Visit this website".');
    console.log('  Both devices must be on the same Wi-Fi network.\n');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('\n  Port ' + PORT + ' is busy. Try:  PORT=8444 node serve.js\n');
  else console.error(e);
});

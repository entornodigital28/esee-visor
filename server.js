// Esee Visor: servidor local que toma el video del DVR (protocolo EseeCloud/kp2p)
// y lo sirve a navegadores (Fire TV, iPhone, PC) dentro de la red de casa.
// Uso: node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Kp2pClient, PTZ } = require('./lib/kp2p');
const { Fmp4Muxer, TIMESCALE } = require('./lib/fmp4');
const { RecSearch, replay, dvrNow } = require('./lib/recordings');
const crypto = require('crypto');

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const cams = JSON.parse(fs.readFileSync(path.join(ROOT, 'cameras.json'), 'utf8'));
const PORT = Number(process.env.PORT) || cams.port || 8080;
const { execFile, execFileSync } = require('child_process');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim();
const VERSION = (() => {
  let v = '0';
  try { v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { /* sin package.json */ }
  try { v += '+' + git('rev-parse', '--short', 'HEAD'); } catch { /* sin git */ }
  return v;
})();
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// Actualización automática (solo si se inició con iniciar.bat): cada 10 minutos mira GitHub;
// si hay cambios, el servidor se cierra y iniciar.bat baja la versión nueva y lo reinicia.
// Las pantallas abiertas se recargan solas al ver que cambió la versión.
if (process.env.ESEE_AUTOUPDATE === '1') {
  setInterval(() => {
    execFile('git', ['fetch', '--quiet'], { cwd: ROOT, timeout: 60000 }, (err) => {
      if (err) return;
      try {
        if (git('rev-parse', 'HEAD') !== git('rev-parse', '@{u}')) { log('hay una versión nueva, reinicio para actualizar'); process.exit(0); }
      } catch { /* sin rama remota */ }
    });
  }, 10 * 60 * 1000);
}

const IDLE_MS = 12000;      // cuánto sigue abierto un canal sin espectadores
const HLS_KEEP = 6;         // segmentos HLS guardados por canal

// ---------- Un canal+calidad en reproducción ----------
class Feed {
  constructor(link, channel) {
    this.link = link; this.channel = channel;
    this.mux = new Fmp4Muxer();
    this.clients = new Set();
    this.gop = [];            // fragmentos desde el último cuadro clave
    this.segs = [];           // HLS: [{ n, dur, data }]
    this.cur = null; this.segN = 0;
    this.lastUse = Date.now(); this.frames = 0;
  }

  meta() { return Buffer.from(JSON.stringify({ codec: this.mux.codec, width: this.mux.width, height: this.mux.height })); }

  // Un cliente es { res, tag }: varias cámaras comparten una misma respuesta HTTP,
  // cada registro lleva su "tag" (posición de la cámara en el pedido).
  // Registro: [largo u32][tipo u8][tag u8][datos]. Tipos: 0 = formato (JSON), 1 = inicio MP4, 2 = fragmento, 3 = fragmento con cuadro clave.
  static write(client, type, payload) {
    const h = Buffer.alloc(6); h.writeUInt32BE(payload.length + 2, 0); h[4] = type; h[5] = client.tag;
    client.res.write(h); client.res.write(payload);
  }

  addClient(client) {
    this.clients.add(client); this.lastUse = Date.now();
    if (this.mux.init) {
      Feed.write(client, 0, this.meta()); Feed.write(client, 1, this.mux.init);
      this.gop.forEach((f, i) => Feed.write(client, i === 0 ? 3 : 2, f));
    }
    client.res.on('close', () => { this.clients.delete(client); this.lastUse = Date.now(); });
  }

  send(type, payload) {
    for (const client of this.clients) {
      if (client.res.writableLength > 8 * 1024 * 1024) { client.res.destroy(); this.clients.delete(client); continue; } // cliente trabado
      Feed.write(client, type, payload);
    }
  }

  push(frame) {
    const r = this.mux.push(frame);
    if (r.newInit) {
      // formato nuevo (o reinicio): el navegador rearma su reproductor al recibir el tipo 0
      this.gop = []; this.segs = []; this.cur = null;
      this.send(0, this.meta()); this.send(1, this.mux.init);
    }
    for (const f of r.frags) {
      this.frames++;
      if (f.key) {
        this.gop = [];
        if (this.cur && this.cur.parts.length) {
          this.segs.push({ n: this.cur.n, dur: this.cur.dur / TIMESCALE, data: Buffer.concat(this.cur.parts) });
          if (this.segs.length > HLS_KEEP) this.segs.shift();
        }
        this.cur = { n: ++this.segN, dur: 0, parts: [] };
      }
      this.gop.push(f.data);
      if (this.cur) { this.cur.parts.push(f.data); this.cur.dur += f.duration; }
      this.send(f.key ? 3 : 2, f.data);
    }
  }

  // Audio (G.711 A-law, 8 kHz): solo a los clientes que lo pidieron. Tipo 6 = [hora u64][muestras]
  pushAudio(f) {
    if (!f.enc.startsWith('G711A')) return;
    let head = null;
    for (const client of this.clients) {
      if (!client.audio) continue;
      if (!head) { head = Buffer.alloc(8); head.writeDoubleBE(f.ts, 0); head = Buffer.concat([head, f.data]); }
      Feed.write(client, 6, head);
    }
  }

  reset() { this.mux.reset(); this.gop = []; this.segs = []; this.cur = null; this.frames = 0; }
}

// ---------- Una conexión al DVR por calidad (0 = alta, 1 = baja) ----------
class DvrLink {
  constructor(stream) { this.stream = stream; this.feeds = new Map(); this.client = null; this.ready = false; this.retry = null; }

  feed(channel) {
    let f = this.feeds.get(channel);
    if (!f) {
      f = new Feed(this, channel); this.feeds.set(channel, f);
      log(`abro canal ${channel + 1} (${this.stream ? 'baja' : 'alta'})`);
      if (this.ready) this.client.openStream(channel, this.stream); else this.connect();
    }
    f.lastUse = Date.now();
    return f;
  }

  connect() {
    if (this.client) return;
    const c = this.client = new Kp2pClient({ host: cfg.host, port: cfg.port || 10000, user: cfg.user, password: cfg.password });
    c.on('login', (r) => {
      if (r !== 0) { log('el DVR rechazó usuario/clave (código ' + r + '). Revisá config.json'); c.close(); return; }
      this.ready = true;
      for (const ch of this.feeds.keys()) c.openStream(ch, this.stream);
      if (this.onReady) { const fn = this.onReady; this.onReady = null; fn(); }
    });
    c.on('video', (f) => { const feed = this.feeds.get(f.channel); if (feed) feed.push(f); });
    c.on('audio', (f) => { const feed = this.feeds.get(f.channel); if (feed) feed.pushAudio(f); });
    c.on('ptz', (r) => { if (r !== 0) log('PTZ respondió código', r); });
    c.on('error', (e) => log('DVR:', e.message));
    c.on('close', () => {
      if (this.client !== c) return;
      this.client = null; this.ready = false;
      for (const f of this.feeds.values()) f.reset();
      if (this.feeds.size && !this.retry) this.retry = setTimeout(() => { this.retry = null; if (this.feeds.size) this.connect(); }, 2000);
    });
    c.connect();
  }

  sweep() {
    const now = Date.now();
    for (const [ch, f] of this.feeds) {
      if (!f.clients.size && now - f.lastUse > IDLE_MS) {
        log(`cierro canal ${ch + 1} (${this.stream ? 'baja' : 'alta'})`);
        if (this.ready) this.client.closeStream(ch, this.stream);
        this.feeds.delete(ch);
      }
    }
    if (!this.feeds.size && this.client && !this.keepUntil) { const c = this.client; this.client = null; this.ready = false; c.close(); }
    if (this.keepUntil && now > this.keepUntil) this.keepUntil = 0;
  }
}

const links = [new DvrLink(0), new DvrLink(1)];
setInterval(() => links.forEach((l) => l.sweep()), 3000);

// ---------- Movimiento (PTZ) ----------
const ptzStopTimers = new Map();
function ptz(channel, action, speed) {
  const code = PTZ[action];
  if (code === undefined) return false;
  const link = links.find((l) => l.ready) || links[1];
  const doIt = () => link.client && link.client.ptz(channel, code, speed, 0);
  link.keepUntil = Date.now() + 20000;
  if (link.ready) doIt(); else { link.onReady = doIt; link.connect(); }
  clearTimeout(ptzStopTimers.get(channel));
  if (code !== PTZ.stop && code !== PTZ.presetGo && code !== PTZ.presetSet) {
    // seguro: si el control no manda "stop", frenar solo a los 6 s
    ptzStopTimers.set(channel, setTimeout(() => { if (link.client) link.client.ptz(channel, PTZ.stop, 0, 0); }, 6000));
  }
  return true;
}

const recSearch = new RecSearch(cfg);

// ---------- Acceso con PIN (opcional: "pin" en config.json) ----------
const PIN = String(process.env.ESEE_PIN || cfg.pin || '');
const SECRET = PIN ? crypto.createHmac('sha256', PIN + '|' + cfg.password).update('esee-visor').digest() : null;
const YEAR = 365 * 86400000, FACE_SESSION = 12 * 3600000; // con PIN dura un año; con Face ID, 12 horas
function sessionCookie(ms) {
  const exp = String(Date.now() + ms);
  return `ev=${exp}.${crypto.createHmac('sha256', SECRET).update(exp).digest('hex')}; Path=/; Max-Age=${Math.floor(ms / 1000)}; HttpOnly; SameSite=Lax`;
}
const pinFails = new Map();
function authed(req) {
  if (!PIN) return true;
  const c = /(?:^|;\s*)ev=(\d{10,16})\.([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '');
  if (!c || Number(c[1]) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(c[2], 'hex'), crypto.createHmac('sha256', SECRET).update(c[1]).digest());
}
async function readBody(req, max = 4000) { let b = ''; for await (const chunk of req) { b += chunk; if (b.length > max) break; } return b; }

// ---------- Llaves de acceso (passkeys): entrar con Face ID / huella en vez del PIN ----------
// Solo funcionan en páginas HTTPS con nombre (o en localhost). Se registran estando ya adentro con el PIN.
const PASSKEYS_FILE = path.join(ROOT, 'passkeys.json');
let passkeys = []; try { passkeys = JSON.parse(fs.readFileSync(PASSKEYS_FILE, 'utf8')); } catch { /* todavía no hay */ }
const savePasskeys = () => fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(passkeys, null, 2) + '\n');
const challenges = new Map(); // desafío -> vencimiento
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
function reqHost(req) { return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim(); }
const rpIdOf = (req) => reqHost(req).replace(/:\d+$/, '');
function newChallenge() {
  const now = Date.now(); for (const [k, v] of challenges) if (v < now) challenges.delete(k);
  const c = crypto.randomBytes(32).toString('base64url'); challenges.set(c, now + 120000); return c;
}
// Valida lo que firma el navegador: tipo de operación, desafío vigente y que venga de esta misma dirección
function checkClientData(req, b64, type) {
  const raw = Buffer.from(String(b64 || ''), 'base64url');
  let cd; try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('datos inválidos'); }
  if (cd.type !== type) throw new Error('operación inesperada');
  const exp = challenges.get(cd.challenge);
  if (!exp || exp < Date.now()) throw new Error('el pedido venció, probá de nuevo');
  challenges.delete(cd.challenge);
  // el origen debe ser esta misma dirección (por nombre; el puerto puede diferir detrás de un proxy como Tailscale)
  let o; try { o = new URL(cd.origin); } catch { throw new Error('origen inválido'); }
  const names = [req.headers['x-forwarded-host'], req.headers.host].filter(Boolean).map((h) => String(h).split(',')[0].trim().replace(/:\d+$/, '').toLowerCase());
  const local = o.hostname === 'localhost' || o.hostname === '127.0.0.1';
  if (!names.includes(o.hostname.toLowerCase()) || (o.protocol !== 'https:' && !local)) throw new Error(`origen no permitido (${cd.origin}; el servidor se ve como ${names.join(' / ')})`);
  return raw;
}

const html = (res, code, text) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const validChannel = (ch) => Number.isInteger(ch) && cams.cameras.some((c) => c.channel === ch);

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

function waitFor(test, ms) {
  return new Promise((resolve) => { const t0 = Date.now(); const tick = () => (test() || Date.now() - t0 > ms) ? resolve(test()) : setTimeout(tick, 150); tick(); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;
  try {
    // --- acceso ---
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress, f = pinFails.get(ip);
      if (f && f.n >= 5 && Date.now() < f.until) return json(res, 429, { error: 'Demasiados intentos. Esperá un minuto.' });
      let q = {}; try { q = JSON.parse(await readBody(req)); } catch { /* cuerpo inválido */ }
      if (PIN && String(q.pin) === PIN) {
        pinFails.delete(ip);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(YEAR) });
        return res.end('{"ok":true}');
      }
      const n = (f && Date.now() < f.until ? f.n : 0) + 1; pinFails.set(ip, { n, until: Date.now() + 60000 });
      return json(res, 401, { error: 'PIN incorrecto' });
    }
    // Face ID: desafío (público), entrar (público) y registrar (solo ya adentro)
    if (p === '/api/passkey/challenge') {
      const rpId = rpIdOf(req);
      return json(res, 200, { challenge: newChallenge(), rpId, ids: passkeys.filter((k) => k.rpId === rpId).map((k) => k.id) });
    }
    if (p === '/api/passkey/login' && req.method === 'POST') {
      if (!PIN) return json(res, 400, { error: 'No hay PIN configurado' });
      try {
        const q = JSON.parse(await readBody(req, 20000));
        const key = passkeys.find((k) => k.id === q.id && k.rpId === rpIdOf(req));
        if (!key) throw new Error('este dispositivo no está registrado');
        const cdRaw = checkClientData(req, q.clientDataJSON, 'webauthn.get');
        const ad = Buffer.from(String(q.authenticatorData || ''), 'base64url');
        if (ad.length < 37 || !ad.subarray(0, 32).equals(sha256(key.rpId))) throw new Error('respuesta de otra dirección');
        if ((ad[32] & 0x05) !== 0x05) throw new Error('falta la verificación biométrica');
        const ok = crypto.verify('sha256', Buffer.concat([ad, sha256(cdRaw)]), { key: Buffer.from(key.publicKey, 'base64url'), format: 'der', type: 'spki' }, Buffer.from(String(q.signature || ''), 'base64url'));
        if (!ok) throw new Error('firma inválida');
        key.lastUsed = new Date().toISOString(); savePasskeys();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(FACE_SESSION) });
        return res.end('{"ok":true}');
      } catch (e) { log('Face ID: ingreso rechazado:', e.message); return json(res, 401, { error: e.message }); }
    }
    if (p === '/api/passkey/register' && req.method === 'POST') {
      if (!PIN || !authed(req)) { log('Face ID: registro sin sesión'); return json(res, 401, { error: 'La sesión venció: recargá, entrá con el PIN y probá de nuevo' }); }
      try {
        const q = JSON.parse(await readBody(req, 20000));
        checkClientData(req, q.clientDataJSON, 'webauthn.create');
        if (q.alg !== -7 && q.alg !== -257) throw new Error('tipo de llave no soportado');
        const pub = Buffer.from(String(q.publicKey || ''), 'base64url');
        crypto.createPublicKey({ key: pub, format: 'der', type: 'spki' }); // valida el formato
        if (!/^[A-Za-z0-9_-]{16,400}$/.test(String(q.id))) throw new Error('identificador inválido');
        passkeys = passkeys.filter((k) => k.id !== q.id);
        passkeys.push({ id: q.id, rpId: rpIdOf(req), publicKey: pub.toString('base64url'), alg: q.alg, name: String(q.name || 'dispositivo').slice(0, 60), created: new Date().toISOString() });
        savePasskeys();
        log('Face ID registrado para', passkeys[passkeys.length - 1].name);
        // desde ahora este dispositivo usa sesión corta: la cara se pide de nuevo al vencer
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(FACE_SESSION) });
        return res.end('{"ok":true}');
      } catch (e) { log('Face ID: no se pudo registrar:', e.message); return json(res, 400, { error: e.message }); }
    }

    if (!authed(req)) {
      if (p === '/' || p === '/index.html') return fs.readFile(path.join(ROOT, 'public', 'login.html'), (err, data) => html(res, err ? 500 : 200, err ? 'error' : data));
      if (p !== '/manifest.webmanifest') return json(res, 401, { error: 'Hace falta el PIN' });
    }

    if (p === '/api/info') return json(res, 200, { version: VERSION, pin: !!PIN, cameras: cams.cameras.map((c) => ({ channel: c.channel, name: c.name, ptz: !!c.ptz })) });

    // Video en vivo de una o varias cámaras por una sola conexión: /live?s=0:1,1:1,4:0  (canal:calidad); con &a=1 incluye el audio
    if (p === '/live') {
      const specs = (url.searchParams.get('s') || '').split(',').filter(Boolean).slice(0, 32).map((x) => x.split(':').map(Number));
      if (!specs.length || specs.some(([ch, st]) => !validChannel(ch) || (st !== 0 && st !== 1))) return json(res, 400, { error: 'pedido inválido' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.socket.setNoDelay(true);
      const audio = url.searchParams.get('a') === '1';
      specs.forEach(([ch, st], tag) => links[st].feed(ch).addClient({ res, tag, audio }));
      return;
    }

    if ((m = p.match(/^\/hls\/(\d+)\/([01])\/(index\.m3u8|init\.mp4|seg(\d+)\.m4s)$/))) {
      const ch = +m[1], st = +m[2];
      if (!validChannel(ch)) return json(res, 404, { error: 'canal inexistente' });
      const feed = links[st].feed(ch);
      if (m[3] === 'index.m3u8') {
        await waitFor(() => links[st].feeds.get(ch) === feed && feed.segs.length >= 2, 12000);
        const segs = feed.segs.slice(-4);
        if (!segs.length) { res.writeHead(503); return res.end(); }
        const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...segs.map((s) => s.dur))), '#EXT-X-MEDIA-SEQUENCE:' + segs[0].n, '#EXT-X-MAP:URI="init.mp4"'];
        for (const s of segs) lines.push('#EXTINF:' + s.dur.toFixed(3) + ',', 'seg' + s.n + '.m4s');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
        return res.end(lines.join('\n') + '\n');
      }
      if (m[3] === 'init.mp4') {
        if (!feed.mux.init) { res.writeHead(503); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
        return res.end(feed.mux.init);
      }
      const seg = feed.segs.find((s) => s.n === +m[4]);
      if (!seg) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'video/iso.segment', 'Cache-Control': 'no-store' });
      return res.end(seg.data);
    }

    // Grabaciones de un día: /api/rec/list?ch=0&day=2026-11-11
    if (p === '/api/rec/list') {
      const ch = Number(url.searchParams.get('ch'));
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(url.searchParams.get('day') || '');
      if (!validChannel(ch) || !d) return json(res, 400, { error: 'pedido inválido' });
      const begin = Date.UTC(+d[1], +d[2] - 1, +d[3]) / 1000;
      try { return json(res, 200, { begin, now: dvrNow(), segs: await recSearch.day(ch, begin) }); }
      catch (e) { log('búsqueda de grabaciones:', e.message); return json(res, 502, { error: e.message }); }
    }

    // Reproducir grabación: /rec?ch=0&t=<segundos DVR>
    if (p === '/rec') {
      const ch = Number(url.searchParams.get('ch')), t = Math.floor(Number(url.searchParams.get('t')));
      if (!validChannel(ch) || !(t > 0)) return json(res, 400, { error: 'pedido inválido' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.socket.setNoDelay(true);
      replay(cfg, ch, t, res, log);
      return;
    }

    // Diagnóstico que mandan las pantallas: se guarda lo último de cada dispositivo en diag.log
    if (p === '/api/diag' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20000) break; }
      fs.appendFile(path.join(ROOT, 'diag.log'), new Date().toISOString() + ' ' + req.socket.remoteAddress + ' ' + body.slice(0, 20000) + '\n', () => {});
      return json(res, 200, { ok: true });
    }

    if (p === '/api/ptz' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2000) break; }
      const q = JSON.parse(body || '{}');
      const ch = Number(q.channel);
      if (!validChannel(ch)) return json(res, 404, { error: 'canal inexistente' });
      const speed = Math.max(0, Math.min(8, Number(q.speed) || 0));
      return json(res, ptz(ch, String(q.action), speed) ? 200 : 400, { ok: true });
    }

    // archivos estáticos
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.normalize(path.join(ROOT, 'public', rel));
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('no encontrado'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    log('error en', p, e.message);
    if (!res.headersSent) json(res, 500, { error: 'error interno' }); else res.destroy();
  }
});

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  log(`Esee Visor ${VERSION} listo. Abrí en la tele o el celular:`);
  for (const ip of ips) log(`   http://${ip}:${PORT}`);
});

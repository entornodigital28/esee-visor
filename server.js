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
const { Ewelink } = require('./lib/ewelink');
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
const SESSION = PIN ? crypto.createHmac('sha256', PIN + '|' + cfg.password).update('esee-visor').digest('hex') : '';
const pinFails = new Map();
function authed(req) {
  if (!PIN) return true;
  const c = /(?:^|;\s*)ev=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return !!c && c[1].length === SESSION.length && crypto.timingSafeEqual(Buffer.from(c[1]), Buffer.from(SESSION));
}
async function readBody(req, max = 4000) { let b = ''; for await (const chunk of req) { b += chunk; if (b.length > max) break; } return b; }

// ---------- eWeLink: botones de acción por cámara ----------
const ewe = new Ewelink(path.join(ROOT, 'ewelink.json'));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eweRedirect = () => ewe.cfg.redirectUrl || `http://localhost:${PORT}/ewelink/callback`;
function ewePage(msg) {
  const css = 'body{font:15px/1.5 system-ui,sans-serif;background:#0b0d10;color:#e8ecf1;max-width:760px;margin:32px auto;padding:0 16px}a,button{color:#3ea6ff}code{background:#1b2027;padding:2px 6px;border-radius:4px}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border-bottom:1px solid #262c34;padding:8px;text-align:left}button{background:#14181d;border:1px solid #262c34;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}.msg{background:#1b2027;border-left:3px solid #3ea6ff;padding:10px 14px;margin:14px 0}';
  let body = '<h1>eWeLink</h1>';
  if (msg) body += `<div class="msg">${esc(msg)}</div>`;
  if (!ewe.hasApp) {
    body += `<p>Falta la aplicación de desarrollador de eWeLink.</p><ol><li>Entrá a <a href="https://dev.ewelink.cc" target="_blank" rel="noopener">dev.ewelink.cc</a> con tu cuenta de eWeLink y completá la certificación de desarrollador.</li><li>En <b>Platform → App Management</b> creá una aplicación. Como dirección de redirección poné exactamente <code>${esc(eweRedirect())}</code></li><li>Copiá el <b>APPID</b> y el <b>APP SECRET</b> en el archivo <code>ewelink.json</code> de la carpeta del servidor y reiniciá el servidor.</li></ol>`;
  } else if (!ewe.linked) {
    body += `<p>La aplicación está configurada. Falta conectar tu cuenta (hacelo desde la computadora donde corre el servidor).</p><p><a href="/ewelink/login">Conectar cuenta de eWeLink</a></p>`;
  } else {
    const rows = Object.entries(ewe.cfg.devices).map(([id, d]) => `<tr><td>${esc(d.name)}</td><td><code>${esc(id)}</code></td><td>${d.ip ? esc(d.ip) : 'solo nube'}</td><td>${d.outlets ? d.outlets + ' canales' : '1 canal'}</td><td><form method="post" action="/ewelink/test" style="display:inline"><input type="hidden" name="id" value="${esc(id)}"><button name="do" value="on">Encender</button> <button name="do" value="off">Apagar</button></form></td></tr>`).join('');
    body += `<p>Cuenta conectada (región ${esc(ewe.cfg.region)}).</p><table><tr><th>Nombre</th><th>ID</th><th>Red local</th><th>Tipo</th><th>Probar</th></tr>${rows || '<tr><td colspan="5">Sin dispositivos compatibles</td></tr>'}</table><p><a href="/ewelink/sync">Actualizar lista</a> · <a href="/ewelink/login">Volver a conectar la cuenta</a></p><p>Para agregar un botón a una cámara, usá el ID en <code>cameras.json</code>.</p>`;
  }
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>eWeLink</title><style>${css}</style>${body}<p><a href="/">Volver a las cámaras</a></p></html>`;
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
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `ev=${SESSION}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` });
        return res.end('{"ok":true}');
      }
      const n = (f && Date.now() < f.until ? f.n : 0) + 1; pinFails.set(ip, { n, until: Date.now() + 60000 });
      return json(res, 401, { error: 'PIN incorrecto' });
    }
    if (!authed(req)) {
      if (p === '/' || p === '/index.html') return fs.readFile(path.join(ROOT, 'public', 'login.html'), (err, data) => html(res, err ? 500 : 200, err ? 'error' : data));
      if (p !== '/manifest.webmanifest') return json(res, 401, { error: 'Hace falta el PIN' });
    }

    if (p === '/api/info') return json(res, 200, { version: VERSION, pin: !!PIN, cameras: cams.cameras.map((c) => ({ channel: c.channel, name: c.name, ptz: !!c.ptz, actions: (c.actions || []).map((a) => ({ label: a.label })) })) });

    // --- acciones (eWeLink) ---
    if (p === '/api/action' && req.method === 'POST') {
      if (!PIN) return json(res, 403, { error: 'Las acciones necesitan un PIN: agregá "pin" en config.json y reiniciá.' });
      let q = {}; try { q = JSON.parse(await readBody(req)); } catch { /* cuerpo inválido */ }
      const cam = cams.cameras.find((c) => c.channel === Number(q.channel));
      const a = cam && (cam.actions || [])[Number(q.index)];
      if (!a) return json(res, 404, { error: 'acción inexistente' });
      try { const via = await ewe.run(a); log(`acción "${a.label}" (${cam.name}) ejecutada por ${via}`); return json(res, 200, { ok: true, via }); }
      catch (e) { log(`acción "${a.label}" falló:`, e.message); return json(res, 502, { error: e.message }); }
    }
    if (p === '/ewelink') return html(res, 200, ewePage(url.searchParams.get('m')));
    if (p === '/ewelink/login') { if (!ewe.hasApp) return html(res, 200, ewePage()); res.writeHead(302, { Location: ewe.authUrl(eweRedirect()) }); return res.end(); }
    if (p === '/ewelink/callback') {
      try { const d = await ewe.exchange(url.searchParams.get('code'), url.searchParams.get('region'), eweRedirect(), url.searchParams.get('state')); return html(res, 200, ewePage(`Cuenta conectada: ${Object.keys(d).length} dispositivos.`)); }
      catch (e) { log('eWeLink:', e.message); return html(res, 200, ewePage('No se pudo conectar la cuenta: ' + e.message)); }
    }
    if (p === '/ewelink/sync') { try { await ewe.syncDevices(); return html(res, 200, ewePage('Lista actualizada.')); } catch (e) { return html(res, 200, ewePage('No se pudo actualizar: ' + e.message)); } }
    if (p === '/ewelink/test' && req.method === 'POST') {
      if (!PIN) return html(res, 200, ewePage('Para probar dispositivos primero configurá un PIN en config.json.'));
      const f = new URLSearchParams(await readBody(req));
      try { const via = await ewe.set(String(f.get('id')), f.get('do') === 'on', undefined); return html(res, 200, ewePage(`Listo (${via}).`)); }
      catch (e) { return html(res, 200, ewePage('Falló: ' + e.message)); }
    }

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

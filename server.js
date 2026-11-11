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

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const cams = JSON.parse(fs.readFileSync(path.join(ROOT, 'cameras.json'), 'utf8'));
const PORT = cams.port || 8080;
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
  // Registro: [largo u32][tipo u8][tag u8][datos]. Tipos: 0 = formato (JSON), 1 = inicio MP4, 2 = fragmento.
  static write(client, type, payload) {
    const h = Buffer.alloc(6); h.writeUInt32BE(payload.length + 2, 0); h[4] = type; h[5] = client.tag;
    client.res.write(h); client.res.write(payload);
  }

  addClient(client) {
    this.clients.add(client); this.lastUse = Date.now();
    if (this.mux.init) {
      Feed.write(client, 0, this.meta()); Feed.write(client, 1, this.mux.init);
      for (const f of this.gop) Feed.write(client, 2, f);
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
      this.send(2, f.data);
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
    if (p === '/api/info') return json(res, 200, { version: VERSION, cameras: cams.cameras });

    // Video en vivo de una o varias cámaras por una sola conexión: /live?s=0:1,1:1,4:0  (canal:calidad)
    if (p === '/live') {
      const specs = (url.searchParams.get('s') || '').split(',').filter(Boolean).slice(0, 32).map((x) => x.split(':').map(Number));
      if (!specs.length || specs.some(([ch, st]) => !validChannel(ch) || (st !== 0 && st !== 1))) return json(res, 400, { error: 'pedido inválido' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.socket.setNoDelay(true);
      specs.forEach(([ch, st], tag) => links[st].feed(ch).addClient({ res, tag }));
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

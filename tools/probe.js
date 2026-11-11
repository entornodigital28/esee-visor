// Prueba: conecta al DVR, inicia sesión, abre canales y guarda unos segundos de video crudo.
// Uso: node tools/probe.js <ip> [canales=4] [stream=1] [segundos=6]
// La contraseña se toma de la variable de entorno DVR_PASS (vacía por defecto).
'use strict';
const fs = require('fs');
const path = require('path');
const { Kp2pClient } = require('../lib/kp2p');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); } catch { /* sin config */ }
const host = process.argv[2] || cfg.host;
const nCh = parseInt(process.argv[3] || '4', 10);
const stream = parseInt(process.argv[4] || '1', 10);
const secs = parseInt(process.argv[5] || '6', 10);
if (!host) { console.error('falta la IP'); process.exit(2); }
if (process.env.DVR_USER === undefined && cfg.user) process.env.DVR_USER = cfg.user;
if (process.env.DVR_PASS === undefined && cfg.password) process.env.DVR_PASS = cfg.password;

const outDir = path.join(__dirname, '..', 'capturas');
fs.mkdirSync(outDir, { recursive: true });
const c = new Kp2pClient({ host, user: process.env.DVR_USER || 'admin', password: process.env.DVR_PASS || '' });
const stats = {};
const files = {};

c.on('error', (e) => console.log('ERROR', e.message));
c.on('close', () => console.log('conexión cerrada'));
c.on('login', (r) => {
  console.log('login resultado:', r);
  if (r !== 0) { c.close(); return; }
  for (let ch = 0; ch < nCh; ch++) c.openStream(ch, stream);
  setTimeout(() => {
    console.log(JSON.stringify(stats, null, 1));
    c.close(); setTimeout(() => process.exit(0), 300);
  }, secs * 1000);
});
c.on('live', (l) => console.log('live rsp', JSON.stringify(l)));
c.on('video', (f) => {
  const s = stats[f.channel] || (stats[f.channel] = { enc: f.enc, w: f.width, h: f.height, fps: f.fps, frames: 0, key: 0, bytes: 0, audio: 0, head: f.data.subarray(0, 8).toString('hex') });
  s.frames++; s.bytes += f.data.length; if (f.key) s.key++;
  if (!files[f.channel]) { if (!f.key) return; files[f.channel] = fs.openSync(path.join(outDir, `ch${f.channel}_s${stream}.${f.enc.toLowerCase()}`), 'w'); }
  fs.writeSync(files[f.channel], f.data);
});
c.on('audio', (a) => { const s = stats[a.channel]; if (s) { s.audio++; s.audioEnc = `${a.enc}/${a.sampleRate}/${a.sampleWidth}/${a.channels}`; } });
setTimeout(() => { console.log('tiempo agotado', JSON.stringify(stats)); process.exit(1); }, (secs + 12) * 1000);
c.connect();

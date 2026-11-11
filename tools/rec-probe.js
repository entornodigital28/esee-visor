// Diagnóstico de grabaciones: busca archivos y, opcionalmente, pide reproducción.
// Uso: node tools/rec-probe.js <canal> <horasAtras> <tipo> [play]
'use strict';
const fs = require('fs');
const path = require('path');
const { Kp2pClient, CMD } = require('../lib/kp2p');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const ch = parseInt(process.argv[2] || '0', 10);
const hours = parseFloat(process.argv[3] || '6');
const type = parseInt(process.argv[4] || '15', 10);
const play = process.argv[5] === 'play';
const off = parseInt(process.env.TZ_OFF || '0', 10); // segundos a sumar a las horas

function req(cmd, channels, type, begin, end, index, count) {
  const s = Buffer.alloc(52);
  s.writeUInt32LE(cmd, 0);
  for (const c of channels) s[8 + (c >> 3)] |= 1 << (c & 7);
  s.writeUInt32LE(type, 24); s.writeUInt32LE(begin, 32); s.writeUInt32LE(end, 36);
  s.writeUInt32LE(index, 44); s.writeUInt32LE(count, 48);
  return s;
}
const c = new Kp2pClient(cfg);
const now = Math.floor(Date.now() / 1000) + off;
const begin = now - Math.round(hours * 3600);
let frames = 0, firstTs = null, lastTs = null, keys = 0, bytes = 0, t0 = 0;
c.on('login', (r) => {
  if (r !== 0) { console.log('login', r); process.exit(1); }
  console.log('busco canal', ch, 'tipo', type, 'desde', new Date(begin * 1000).toISOString(), 'hasta', new Date(now * 1000).toISOString());
  c._api(CMD.REPLAY_REQ, req(1, [ch], type, begin, now, 0, 100));
});
c.on('api', (a) => {
  if (a.cmd !== CMD.REPLAY_RSP) return console.log('cmd', a.cmd, 'res', a.result, a.payload.length);
  const p = a.payload;
  console.log('REPLAY_RSP resultado', a.result, 'bytes', p.length);
  console.log('cabecera hex:', p.subarray(0, Math.min(52, p.length)).toString('hex').replace(/(.{8})/g, '$1 '));
  if (p.length >= 52) {
    const cmd = p.readUInt32LE(0), count = p.readUInt32LE(44), total = p.readUInt32LE(48);
    console.log('cmd', cmd, 'index', p.readUInt32LE(40), 'count', count, 'total', total);
    let o = 52; const recs = [];
    while (o + 20 <= p.length) { recs.push({ ch: p.readUInt32LE(o), type: p.readUInt32LE(o + 4), b: p.readUInt32LE(o + 8), e: p.readUInt32LE(o + 12), q: p.readUInt32LE(o + 16) }); o += 20; }
    console.log('registros', recs.length);
    for (const r of recs.slice(0, 6).concat(recs.slice(-3))) console.log('  ch', r.ch, 'tipo', r.type, new Date(r.b * 1000).toISOString(), '->', new Date(r.e * 1000).toISOString(), 'dur', r.e - r.b, 's q', r.q);
    if (cmd === 1 && play && recs.length) {
      const r = recs[Math.floor(recs.length / 2)];
      console.log('reproduzco desde', new Date(r.b * 1000).toISOString());
      t0 = Date.now();
      c._api(CMD.REPLAY_REQ, req(3, [ch], type, r.b, r.e, 0, 0));
      setTimeout(() => {
        console.log('en 8 s:', frames, 'cuadros', keys, 'claves', bytes, 'bytes; ts', firstTs, '->', lastTs, 'cubre', (lastTs - firstTs) / 1000, 's de grabación');
        c._api(CMD.REPLAY_REQ, req(2, [ch], 0, 0, 0, 0, 0));
        setTimeout(() => { c.close(); process.exit(0); }, 800);
      }, 8000);
      return;
    }
    if (cmd === 1) { c.close(); setTimeout(() => process.exit(0), 200); }
  }
});
c.on('replay', (f) => {
  frames++; bytes += f.data.length; if (f.key) keys++;
  if (firstTs === null) { firstTs = f.ts; console.log('primer cuadro a los', Date.now() - t0, 'ms:', JSON.stringify({ kind: f.kind, ch: f.channel, enc: f.enc, w: f.width, h: f.height, fps: f.fps, type: f.rtype, q: f.quality, ts: new Date(f.ts).toISOString(), head: f.data.subarray(0, 6).toString('hex') })); }
  lastTs = f.ts;
});
c.on('error', (e) => { console.log('error', e.message); process.exit(1); });
setTimeout(() => { console.log('tiempo agotado'); process.exit(1); }, 25000);
c.connect();

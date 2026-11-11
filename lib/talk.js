// Hablar por el parlante de una cámara: recibe audio G.711 A-law (8 kHz) del navegador
// en tandas chicas y lo reenvía al DVR en cuadros de 40 ms, a ritmo constante.
// Mientras la cámara reproduce, ella misma silencia su micrófono (es de una vía por vez).
'use strict';
const { Kp2pClient } = require('./kp2p');

const VOP2P_REQ = 60, CALL = 1, HANGUP = 2, IOT_DATA = 19;
const FRAME = 320;          // 40 ms a 8 kHz
const MAX_BUFFER = 8000;    // no acumular más de 1 s de demora
const IDLE_MS = 20000;      // sin audio nuevo por este tiempo: colgar (las pausas al hablar no cuelgan)

const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4)); return b; };

// Cuadro de audio hacia la cámara. "format" permite probar variantes si el sonido no sale limpio.
function audioFrame(channel, data, format) {
  const head = Buffer.alloc(24);
  head.writeUInt32LE(0x4652414d, 0); head.writeUInt32LE(0x01000000, 4);
  head.writeUInt32LE(2, 8);                       // tipo de cuadro: voz hacia el equipo
  head.writeUInt32LE(data.length, 12); head.writeBigUInt64LE(BigInt(Date.now()), 16);
  const param = Buffer.alloc(24); param.write('G711A'); param.writeUInt32LE(8000, 8); param.writeUInt32LE(16, 12); param.writeUInt32LE(1, 16);
  if (format === 'V4') return Buffer.concat([head, data]);
  if (format === 'V3') return Buffer.concat([head, param, data]);
  if (format === 'V2') return Buffer.concat([head, u32(0, channel), param, data]);
  return Buffer.concat([head, u32(0, channel), param, Buffer.alloc(8), data]); // V1: igual al audio que manda el DVR
}

class Talk {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.sessions = new Map(); }

  // Agrega audio para un canal; abre la llamada si hace falta
  push(channel, data, format) {
    let s = this.sessions.get(channel);
    if (!s) {
      s = { channel, buf: Buffer.alloc(0), last: Date.now(), ready: false, format: format || 'V1', client: new Kp2pClient(this.cfg), timer: null };
      this.sessions.set(channel, s);
      const end = () => this.end(s);
      s.client.on('login', (r) => {
        if (r !== 0) return end();
        s.client._api(VOP2P_REQ, u32(CALL, channel));
        s.ready = true;
        this.log(`hablando por la cámara del canal ${channel + 1}`);
      });
      s.client.on('error', end); s.client.on('close', end);
      s.client.connect();
      s.timer = setInterval(() => {
        if (s.ready && s.buf.length >= FRAME) {
          s.client._iot(IOT_DATA, audioFrame(channel, s.buf.subarray(0, FRAME), s.format));
          s.buf = s.buf.subarray(FRAME);
        } else if (Date.now() - s.last > IDLE_MS) end();
      }, 40);
    }
    s.last = Date.now();
    s.buf = Buffer.concat([s.buf, data]);
    if (s.buf.length > MAX_BUFFER) s.buf = s.buf.subarray(s.buf.length - MAX_BUFFER);
  }

  end(s) {
    if (this.sessions.get(s.channel) !== s) return;
    this.sessions.delete(s.channel); clearInterval(s.timer);
    try { if (s.ready) s.client._api(VOP2P_REQ, u32(HANGUP, s.channel)); } catch { /* conexión caída */ }
    setTimeout(() => s.client.close(), 300);
  }

  stop(channel) { const s = this.sessions.get(channel); if (s) this.end(s); }
}

module.exports = { Talk };

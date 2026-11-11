// Cliente del protocolo "kp2p" de los DVR/NVR Juan / EseeCloud (WebSocket, puerto 10000).
// Reimplementado a partir del JavaScript que sirve la propia web del equipo.
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const AES_KEY = Buffer.from('~!JUAN*&Vision-=', 'latin1');
const ARQ_OPEN = Buffer.from('d9ffcc028c38eed2d199ac6026947fae', 'hex');
const ARQ_OPEN_RES = Buffer.from('96d5390d12fcbe8f4790d932ccd849f3', 'hex');
const ARQ_PREFIX = Buffer.from('cefaeffe', 'hex');
const IOT_MAGIC = Buffer.from('abbccdde', 'hex');
const API_MAGIC = 0x4b503250;
const FRAME_MAGIC = 0x4652414d;
const FRAME_MAGIC2 = 0x4652414e;

const IOT = { PING: 17, PONG: 18, DATA: 19, OPEN_REQ: 20, OPEN_RES: 21, DATA_PRIOR: 43 };
const CMD = {
  AUTH_REQ: 10, AUTH_RSP: 11, PTZ_REQ: 20, PTZ_RSP: 21, LIVE_REQ: 30, LIVE_RSP: 31,
  REPLAY_REQ: 40, REPLAY_RSP: 41, SETUP_REQ: 80, SETUP_RSP: 81, SETUP2_REQ: 150, SETUP2_RSP: 151,
};
const PTZ = {
  stop: 0, auto: 1, up: 2, down: 3, left: 4, right: 5, irisOpen: 6, irisClose: 7,
  zoomIn: 8, zoomOut: 9, focusFar: 10, focusNear: 11, aux: 12, presetSet: 13, presetGo: 14, presetClear: 15,
};

function aesField(str) {
  // 32 bytes: dos bloques AES-128-ECB sin padding, rellenados con ceros
  const plain = Buffer.alloc(32);
  plain.write(String(str).slice(0, 31), 'utf8');
  const c = crypto.createCipheriv('aes-128-ecb', AES_KEY, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(plain), c.final()]);
}

class Kp2pClient extends EventEmitter {
  constructor({ host, port = 10000, user = 'admin', password = '' }) {
    super();
    this.host = host; this.port = port; this.user = user; this.password = password;
    this.tick = 0; this.sid = 0; this.opened = false; this.gotFirst = false;
    this.ws = null; this.pingTimer = null; this.closed = false;
  }

  connect() {
    this.sid = 1 + Math.floor(Math.random() * 9999);
    const ws = this.ws = new WebSocket(`ws://${this.host}:${this.port}`);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      const b = Buffer.alloc(20);
      ARQ_OPEN.copy(b); b.writeUInt32LE(this.sid, 16);
      ws.send(b);
    });
    ws.addEventListener('message', (ev) => this._onMessage(Buffer.from(ev.data)));
    ws.addEventListener('close', () => this._onClose('close'));
    ws.addEventListener('error', (e) => { this.emit('error', new Error(e.message || 'error de WebSocket')); });
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.ws && this.ws.close(); } catch { /* ya cerrado */ }
  }

  _onClose(why) {
    clearInterval(this.pingTimer);
    if (!this._closedEmitted) { this._closedEmitted = true; this.emit('close', why); }
  }

  _sendRaw(buf) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const pre = Buffer.alloc(8);
    ARQ_PREFIX.copy(pre); pre.writeUInt32LE(buf.length, 4);
    this.ws.send(pre); this.ws.send(buf);
    return true;
  }

  _iot(cmd, payload) {
    const h = Buffer.alloc(32);
    IOT_MAGIC.copy(h); h[4] = cmd; h[11] = 1;
    h.writeUInt32LE(0, 12); h.writeUInt32LE(this.sid, 16);
    h.writeUInt32LE(payload.length, 28);
    return this._sendRaw(Buffer.concat([h, payload]));
  }

  _api(cmd, payload) {
    this.tick += 1;
    const h = Buffer.alloc(24);
    h.writeUInt32LE(API_MAGIC, 0); h.writeUInt32LE(1, 4);
    h.writeUInt32LE(this.tick, 8); h.writeUInt32LE(cmd, 12);
    h.writeUInt32LE(payload.length, 20);
    return this._iot(IOT.DATA, Buffer.concat([h, payload]));
  }

  _onMessage(d) {
    if (d.length >= 4 && d.subarray(0, 4).equals(ARQ_PREFIX)) return; // prefijo de longitud
    if (!this.gotFirst) {
      this.gotFirst = true;
      if (!d.subarray(0, 16).equals(ARQ_OPEN_RES)) { this.emit('error', new Error('el equipo rechazó la conexión')); this.close(); return; }
      const p = Buffer.alloc(8); p.writeUInt32LE(this.sid, 0); p.writeUInt32LE(0, 4);
      this._iot(IOT.OPEN_REQ, p);
      return;
    }
    if (d.length < 32 || !d.subarray(0, 4).equals(IOT_MAGIC)) return;
    const cmd = d.readUInt32LE(4);
    const ecode = d.readInt32LE(24);
    const body = d.subarray(32);
    if (cmd === IOT.OPEN_RES) {
      if (ecode !== 0) { this.emit('error', new Error('OPEN_RES código ' + ecode)); this.close(); return; }
      this.opened = true;
      this.pingTimer = setInterval(() => this._iot(IOT.PING, Buffer.alloc(96)), 10000);
      this._api(CMD.AUTH_REQ, Buffer.concat([aesField(this.user), aesField(this.password)]));
    } else if (cmd === IOT.DATA || cmd === IOT.DATA_PRIOR) {
      this._onData(body);
    }
  }

  _onData(r) {
    if (r.length < 4) return;
    const magic = r.readUInt32LE(0);
    if (magic === API_MAGIC) {
      if (r.length < 24) return;
      const cmd = r.readUInt32LE(12), result = r.readInt32LE(16);
      const p = r.subarray(24);
      if (cmd === CMD.AUTH_RSP) this.emit('login', result);
      else if (cmd === CMD.LIVE_RSP && p.length >= 12) {
        let desc = ''; for (let i = 12; i < 32 && i < p.length && p[i]; i++) desc += String.fromCharCode(p[i]);
        this.emit('live', { channel: p.readUInt32LE(0), stream: p.readUInt32LE(4), liveCmd: p.readUInt32LE(8), result, desc });
      } else if (cmd === CMD.PTZ_RSP) this.emit('ptz', result);
      else if (cmd === CMD.SETUP_RSP && p.length >= 4) {
        const n = p.readUInt32LE(0); this.emit('setup', p.subarray(4, 4 + n).toString('utf8'), result);
      } else if (cmd === CMD.SETUP2_RSP && p.length >= 36) {
        const n = p.readUInt32LE(32); this.emit('setup', p.subarray(36, 36 + n).toString('utf8'), result);
      } else this.emit('api', { cmd, result, payload: p });
    } else if (magic === FRAME_MAGIC || magic === FRAME_MAGIC2) {
      if (magic === FRAME_MAGIC2) r = r.subarray(40);
      if (r.length < 24 + 8 + 24) return;
      const headtype = r.readUInt32LE(8);
      const ts = Number(r.readBigUInt64LE(16));
      r = r.subarray(24);
      if (headtype !== 0) return; // solo vivo por ahora
      const frametype = r.readUInt32LE(0), channel = r.readUInt32LE(4);
      r = r.subarray(8);
      let enc = ''; for (let i = 0; i < 8 && r[i]; i++) enc += String.fromCharCode(r[i]);
      const a = r.readUInt32LE(8), b = r.readUInt32LE(12), c = r.readUInt32LE(16);
      const data = r.subarray(24 + 8);
      if (frametype === 0) this.emit('audio', { channel, enc, sampleRate: a, sampleWidth: b, channels: c, data });
      else if (frametype === 1 || frametype === 2) this.emit('video', { channel, key: frametype === 1, enc, fps: a, width: b, height: c, ts, ts2: Number(r.readBigUInt64LE(24)), data });
    }
  }

  // stream: 0 = principal (alta), 1 = secundario (baja)
  openStream(channel, stream = 1) { return this._live(channel, stream, 2); }
  closeStream(channel, stream = 1) { return this._live(channel, stream, 1); }
  _live(channel, stream, liveCmd) {
    const p = Buffer.alloc(12);
    p.writeUInt32LE(channel, 0); p.writeUInt32LE(stream, 4); p.writeUInt32LE(liveCmd, 8);
    return this._api(CMD.LIVE_REQ, p);
  }

  ptz(channel, action, param1 = 0, param2 = 0) {
    const p = Buffer.alloc(16);
    p.writeUInt32LE(channel, 0); p.writeUInt32LE(action, 4); p.writeUInt32LE(param1, 8); p.writeUInt32LE(param2, 12);
    return this._api(CMD.PTZ_REQ, p);
  }

  remoteSetup(jsonText) {
    const s = Buffer.from(jsonText, 'utf8');
    const p = Buffer.alloc(2052); p.writeUInt32LE(s.length, 0); s.copy(p, 4, 0, Math.min(s.length, 2047));
    return this._api(CMD.SETUP_REQ, p);
  }
}

module.exports = { Kp2pClient, PTZ, CMD };

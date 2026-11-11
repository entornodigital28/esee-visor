// Empaquetador mínimo de H.264 (Annex-B) a MP4 fragmentado, para reproducir en navegadores.
'use strict';

const TIMESCALE = 90000;

function box(type, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(size, 0); h.write(type, 4, 'latin1');
  return Buffer.concat([h, ...parts], size);
}
const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b; };
const u16 = (...v) => { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeUInt16BE(x, i * 2)); return b; };
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

// Separa un búfer Annex-B en unidades NAL (sin el código de inicio)
function splitNals(d) {
  const out = [];
  let start = -1;
  const n = d.length;
  for (let i = 0; i + 2 < n; i++) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      if (start >= 0) { let end = i; while (end > start && d[end - 1] === 0) end--; out.push(d.subarray(start, end)); }
      start = i + 3; i += 2;
    }
  }
  if (start >= 0 && start < n) out.push(d.subarray(start, n));
  return out;
}

function initSegment(sps, pps, width, height, duration = 0, withAudio = false) {
  const avcC = box('avcC', Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), u16(sps.length), sps, Buffer.from([1]), u16(pps.length), pps);
  const avc1 = box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(width, height), u32(0x00480000, 0x00480000, 0), u16(1), Buffer.alloc(32), u16(0x18, 0xffff), avcC);
  const stbl = box('stbl',
    box('stsd', u32(0, 1), avc1),
    box('stts', u32(0, 0)), box('stsc', u32(0, 0)), box('stsz', u32(0, 0, 0)), box('stco', u32(0, 0)));
  const minf = box('minf',
    box('vmhd', u32(1), Buffer.alloc(8)),
    box('dinf', box('dref', u32(0, 1), box('url ', u32(1)))),
    stbl);
  const mdia = box('mdia',
    box('mdhd', u32(0, 0, 0, TIMESCALE, 0), u16(0x55c4, 0)),
    box('hdlr', u32(0, 0), Buffer.from('vide', 'latin1'), Buffer.alloc(12), Buffer.from('VideoHandler\0', 'latin1')),
    minf);
  const trak = box('trak',
    box('tkhd', u32(7, 0, 0, 1, 0, 0), Buffer.alloc(8), u16(0, 0, 0, 0), MATRIX, u32(width << 16, height << 16)),
    mdia);
  const tracks = [trak];
  const mvex = [];
  if (duration > 0) mvex.push(box('mehd', u32(0, duration)));
  mvex.push(box('trex', u32(0, 1, 1, 0, 0, 0)));
  if (withAudio) {
    const sowt = box('sowt', Buffer.alloc(6), u16(1), u16(0, 0), u32(0), u16(1, 16), u16(0, 0), u32(8000 * 65536));
    const audioStbl = box('stbl', box('stsd', u32(0, 1), sowt), box('stts', u32(0, 0)), box('stsc', u32(0, 0)), box('stsz', u32(0, 0, 0)), box('stco', u32(0, 0)));
    const audioMinf = box('minf', box('smhd', u32(0), u16(0, 0)), box('dinf', box('dref', u32(0, 1), box('url ', u32(1)))), audioStbl);
    const audioMdia = box('mdia', box('mdhd', u32(0, 0, 0, 8000, 0), u16(0x55c4, 0)), box('hdlr', u32(0, 0), Buffer.from('soun', 'latin1'), Buffer.alloc(12), Buffer.from('SoundHandler\0', 'latin1')), audioMinf);
    tracks.push(box('trak', box('tkhd', u32(7, 0, 0, 2, 0, 0), Buffer.alloc(8), u16(0, 0, 0x0100, 0), MATRIX, u32(0, 0)), audioMdia));
    mvex.push(box('trex', u32(0, 2, 1, 0, 0, 0)));
  }
  const moov = box('moov',
    box('mvhd', u32(0, 0, 0, TIMESCALE, 0, 0x00010000), u16(0x0100, 0), Buffer.alloc(8), MATRIX, Buffer.alloc(24), u32(withAudio ? 3 : 2)),
    ...tracks,
    box('mvex', ...mvex));
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(0x200), Buffer.from('isomiso6avc1mp41', 'latin1'));
  return Buffer.concat([ftyp, moov]);
}

function fragment(seq, dts, duration, sample, key, trackId = 1) {
  const tfdt = Buffer.alloc(12);
  tfdt.writeUInt32BE(0x01000000, 0); tfdt.writeBigUInt64BE(BigInt(dts), 4);
  const moofSize = 8 + 16 + 8 + 16 + 20 + 32; // moof + mfhd + traf + tfhd + tfdt + trun
  const trun = box('trun', u32(0x000701, 1, moofSize + 8, duration, sample.length, key ? 0x02000000 : 0x01010000));
  const moof = box('moof',
    box('mfhd', u32(0, seq)),
    box('traf', box('tfhd', u32(0x020000, trackId)), box('tfdt', tfdt), trun));
  return Buffer.concat([moof, box('mdat', sample)]);
}

// Convierte cuadros del DVR en segmento de inicio + fragmentos
class Fmp4Muxer {
  constructor(duration = 0, withAudio = false) { this.duration = duration; this.withAudio = withAudio; this.reset(); }
  reset() { this.sps = null; this.pps = null; this.init = null; this.codec = ''; this.width = 0; this.height = 0; this.pending = null; this.seq = 0; this.baseTs = null; this.lastDts = -1; }

  // Devuelve { newInit, jump?, frags: [{ data, key, duration, dts }] }
  push(frame) {
    const out = { newInit: false, frags: [] };
    const parts = [];
    let sps = null, pps = null;
    for (const nal of splitNals(frame.data)) {
      const t = nal[0] & 31;
      if (t === 7) sps = nal; else if (t === 8) pps = nal;
      else if (t === 1 || t === 5 || t === 6) { const l = Buffer.alloc(4); l.writeUInt32BE(nal.length, 0); parts.push(l, nal); }
    }
    if (sps && pps && (!this.sps || !this.sps.equals(sps) || !this.pps.equals(pps) || this.width !== frame.width)) {
      const had = !!this.init;
      if (had) { this.pending = null; this.baseTs = null; this.lastDts = -1; }
      this.sps = Buffer.from(sps); this.pps = Buffer.from(pps);
      this.width = frame.width; this.height = frame.height;
      this.codec = 'avc1.' + [sps[1], sps[2], sps[3]].map((x) => x.toString(16).padStart(2, '0')).join('');
      this.init = initSegment(this.sps, this.pps, this.width, this.height, this.duration, this.withAudio);
      out.newInit = true;
    }
    if (!this.init || !parts.length) return out;
    if (!this.pending && !frame.key) return out; // siempre arrancar en cuadro clave
    let jumped = false;
    if (this.baseTs === null) { this.baseTs = frame.ts; jumped = true; }
    let dts = Math.round((frame.ts - this.baseTs) * 90);
    const step = frame.fps > 0 ? Math.round(TIMESCALE / frame.fps) : 6000;
    if (dts <= this.lastDts || dts - this.lastDts > TIMESCALE * 2) { // reloj del DVR saltó: seguir con paso nominal
      const want = this.lastDts + step;
      this.baseTs = frame.ts - want / 90; dts = want; jumped = true;
    }
    // ancla: a qué hora real corresponde este punto del video (para grabaciones)
    if (jumped) out.jump = { media: dts / TIMESCALE, ts: frame.ts };
    if (this.pending) {
      const p = this.pending;
      this.seq += 1;
      out.frags.push({ data: fragment(this.seq, p.dts, dts - p.dts, p.sample, p.key), key: p.key, duration: dts - p.dts, dts: p.dts });
    }
    this.lastDts = dts;
    this.pending = { dts, key: frame.key, sample: Buffer.concat(parts) };
    return out;
  }

  pushAudio(data, dts) {
    if (!this.withAudio || !data.length || dts < 0) return null;
    const pcm = Buffer.allocUnsafe(data.length * 2);
    for (let i = 0; i < data.length; i++) {
      const a = data[i] ^ 0x55, seg = (a & 0x70) >> 4; let sample = (a & 0x0f) << 4;
      if (seg === 0) sample += 8; else { sample += 0x108; if (seg > 1) sample <<= seg - 1; }
      pcm.writeInt16LE((a & 0x80) ? sample : -sample, i * 2);
    }
    this.seq += 1;
    return fragment(this.seq, dts, data.length, pcm, true, 2);
  }
}

module.exports = { Fmp4Muxer, TIMESCALE, splitNals };

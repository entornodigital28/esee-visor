// Diagnóstico: intenta abrir una "conexión virtual" (VCON, cmd 50) hacia una cámara y pedirle
// su configuración directamente. Prueba varios formatos y muestra qué responde el DVR.
// Uso: node tools/vcon-probe.js [canal]
'use strict';
const fs = require('fs');
const path = require('path');
const { Kp2pClient } = require('../lib/kp2p');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const ch = parseInt(process.argv[2] || '0', 10);
const VCON = 50, CREATE = 1, DATA = 2, DESTROY = 3;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4)); return b; };
const name = (s) => { const b = Buffer.alloc(32); b.write(s, 'latin1'); return b; };
const query = JSON.stringify({ Version: '1.0.0', Method: 'get', IPCam: { DeviceInfo: {}, ModeSetting: {}, ledPwm: { channelInfo: [] }, AlarmSetting: { MotionDetection: {} } }, Authorization: { Verify: '', username: 'admin', password: '' } });
const c = new Kp2pClient(cfg);
let last = null;
c.on('api', (a) => { last = a; console.log('   <- cmd', a.cmd, 'resultado', a.result, a.payload.length, 'bytes', a.payload.subarray(0, 64).toString('hex'), a.payload.length > 64 ? '| ' + a.payload.subarray(64).toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 300) : ''); });
c.on('setup', (t, r) => console.log('   <- setup', r, t.slice(0, 300)));
async function send(label, payload) { last = null; console.log(label, payload.subarray(0, 48).toString('hex')); c._api(VCON, payload); await wait(1500); return last; }
c.on('login', async (r) => {
  if (r !== 0) process.exit(1);
  const apps = ['RemoteSetup', 'remotesetup', 'IPCam', 'setup'];
  const layouts = {
    'A [cmd][canal][nombre32]': (app) => Buffer.concat([u32(CREATE, ch), name(app)]),
    'B [cmd][nombre32][canal]': (app) => Buffer.concat([u32(CREATE), name(app), u32(ch)]),
    'C [canal][cmd][nombre32]': (app) => Buffer.concat([u32(ch, CREATE), name(app)]),
    'D [cmd][canal][0][nombre32]': (app) => Buffer.concat([u32(CREATE, ch, 0), name(app)]),
  };
  for (const [ln, mk] of Object.entries(layouts)) {
    for (const app of apps) {
      const a = await send(`CREATE ${ln} app=${app}`, mk(app));
      if (a && a.cmd === VCON + 1 && a.result === 0) {
        console.log('   *** CREATE aceptado; mando datos');
        const q = Buffer.from(query, 'latin1');
        const base = mk(app); base.writeUInt32LE(DATA, ln.startsWith('C') ? 4 : 0);
        await send('   DATA +[len][json]', Buffer.concat([base, u32(q.length), q]));
        await send('   DATA +[json]', Buffer.concat([base, q]));
        await wait(2000);
        const d = mk(app); d.writeUInt32LE(DESTROY, ln.startsWith('C') ? 4 : 0);
        await send('   DESTROY', d);
        c.close(); process.exit(0);
      }
    }
  }
  console.log('ningún formato de CREATE fue aceptado');
  c.close(); process.exit(0);
});
c.on('error', (e) => { console.log('error', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 120000);
c.connect();

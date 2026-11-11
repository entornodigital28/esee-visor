// Diagnóstico: envía un pedido de "configuración remota" (JSON) al DVR y muestra la respuesta.
// Uso: node tools/setup.js '{"Method":"get","IPCam":{"ModeSetting":{}}}' [más pedidos...]
// La autorización se agrega sola desde config.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { Kp2pClient } = require('../lib/kp2p');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const reqs = process.argv.slice(2).map((a) => JSON.parse(a));
const c = new Kp2pClient(cfg);
let i = 0, timer = null;
const hide = (s) => s.split(cfg.password).join('***');
function next() {
  clearTimeout(timer);
  if (i >= reqs.length) { c.close(); return setTimeout(() => process.exit(0), 200); }
  const q = Object.assign({ Version: '1.0.0' }, reqs[i++], { Authorization: { Verify: '', username: cfg.user, password: cfg.password } });
  console.log('\n>>> ' + hide(JSON.stringify(q)));
  c.remoteSetup(JSON.stringify(q));
  timer = setTimeout(() => { console.log('<<< (sin respuesta en 5 s)'); next(); }, 5000);
}
c.on('login', (r) => { if (r !== 0) { console.log('login', r); process.exit(1); } next(); });
c.on('setup', (text, result) => { console.log('<<< resultado ' + result + ' (' + text.length + ' bytes)\n' + hide(text).slice(0, 6000)); next(); });
c.on('api', (a) => console.log('<<< otro cmd', a.cmd, 'resultado', a.result, a.payload.length, 'bytes'));
c.on('error', (e) => { console.log('error', e.message); process.exit(1); });
c.connect();

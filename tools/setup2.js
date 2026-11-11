// Diagnóstico: manda pedidos por el segundo canal de configuración (SETUP2, el de la app)
// y muestra la respuesta. Uso: node tools/setup2.js '<json>' ['<json>' ...]
// Si el JSON no trae SessionID se agrega "0x00000000"; usuario y clave van en Authorization si falta.
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
  const q = reqs[i++];
  if (q.SessionID === undefined) q.SessionID = '0x00000000';
  if (q.Authorization === undefined) q.Authorization = { Verify: '', username: cfg.user, password: cfg.password };
  console.log('\n>>> ' + hide(JSON.stringify(q)));
  c.remoteSetup2(JSON.stringify(q));
  timer = setTimeout(() => { console.log('<<< (sin respuesta en 5 s)'); next(); }, 5000);
}
c.on('login', (r) => { if (r !== 0) { console.log('login', r); process.exit(1); } next(); });
c.on('setup', (text, result) => { console.log('<<< resultado ' + result + ' (' + text.length + ' bytes)\n' + hide(text).slice(0, 4000)); next(); });
c.on('api', (a) => { console.log('<<< cmd', a.cmd, 'resultado', a.result, a.payload.length, 'bytes', a.payload.subarray(0, 48).toString('hex')); if (a.cmd === 151) next(); });
c.on('error', (e) => { console.log('error', e.message); process.exit(1); });
c.connect();

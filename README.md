# Esee Visor

Mirá las cámaras de un DVR/NVR chino de los que usan la app **EseeCloud** (firmware Juan / dvr163, por ejemplo el K8210-3WS) desde la tele, el celular o la PC, dentro de tu red de casa y sin pasar por la nube.

Estos equipos no ofrecen RTSP ni ONVIF: solo hablan un protocolo propio ("kp2p") por WebSocket en el puerto 10000. Esee Visor es un servidor chico en Node.js que habla ese protocolo, convierte el video H.264 a MP4 fragmentado y lo muestra en una página web.

## Qué hace

- Grilla con todas las cámaras en vivo.
- Cámara a pantalla completa, en calidad baja o alta (HD).
- Movimiento (PTZ) y zoom, con botones en pantalla, teclado o control remoto.
- Sonido en vivo de la cámara.
- Grabaciones del disco del DVR: línea de tiempo por día con los tramos de movimiento marcados, salto entre eventos, velocidad y zoom de la línea de tiempo.
- Imagen flotante (PiP) donde el navegador lo permite.
- Se actualiza solo: el servidor baja las versiones nuevas desde GitHub y las pantallas abiertas se recargan.
- Sin dependencias: solo hace falta Node.js 22 o más nuevo.

## Instalación

Hace falta una computadora que quede encendida en la misma red que el DVR.

1. Instalá [Node.js](https://nodejs.org) y [Git](https://git-scm.com).
2. Cloná este repositorio.
3. Copiá `config.example.json` como `config.json` y completá la IP, el usuario y la clave del DVR. Ese archivo no se sube nunca a GitHub.
4. Ajustá `cameras.json` con los canales que tengas conectados (los canales empiezan en 0).
5. Ejecutá `iniciar.bat`. Muestra la dirección para abrir, por ejemplo `http://192.168.0.50:8080`.

## Uso

Abrí esa dirección en el navegador del dispositivo.

- **Amazon Fire TV**: con el navegador Silk. Guardala en favoritos.
- **iPhone / iPad**: en Safari, Compartir → "Agregar a inicio" para tenerla como app a pantalla completa.

| Tecla / control | En la grilla | En una cámara |
|---|---|---|
| Flechas | Elegir cámara | Mover la cámara |
| OK / Enter | Abrir | Cambiar calidad baja / HD |
| + / − (o avance / retroceso) | — | Zoom |
| 1 a 9 | Abrir esa cámara | Cambiar a esa cámara |
| Atrás / Esc | — | Volver a la grilla |

## PIN de acceso

Agregá `"pin": "1234"` (el número que quieras) en `config.json` y reiniciá el servidor. Cada dispositivo lo pide una sola vez. Los botones de acción solo funcionan si hay un PIN configurado.

## Botones de acción con eWeLink

Permite agregar a una cámara botones que manejan un dispositivo eWeLink (Sonoff y compatibles), por ejemplo "Abrir reja".

1. Abrí `http://localhost:8080/ewelink` en la computadora del servidor y seguí los pasos: crear la aplicación en [dev.ewelink.cc](https://dev.ewelink.cc), pegar el APPID y el APP SECRET en `ewelink.json` y conectar la cuenta.
2. La página muestra tus dispositivos con su ID y permite probarlos.
3. Agregá el botón a la cámara en `cameras.json`:

```json
{ "channel": 0, "name": "Entrada", "ptz": true,
  "actions": [ { "label": "Abrir reja", "device": "1000xxxxxx", "do": "on" } ] }
```

`do` puede ser `on`, `off`, `toggle` o `pulse` (enciende y apaga a los `seconds` segundos). En dispositivos de varios canales agregá `"outlet": 0`. El control va primero por red local y, si falla, por la nube de eWeLink. En la página, el botón pide un segundo toque para confirmar.

## Seguridad

- Sin PIN, cualquiera conectado a tu red puede ver y mover las cámaras desde la página.
- No abras el puerto 8080 a internet. Para ver las cámaras desde afuera usá una VPN (por ejemplo Tailscale o WireGuard).

## Archivos

- `server.js`: servidor web y manejo de canales.
- `lib/kp2p.js`: cliente del protocolo del DVR.
- `lib/fmp4.js`: empaquetador de H.264 a MP4 fragmentado.
- `public/index.html`: la página del visor.
- `lib/recordings.js`: búsqueda y reproducción de grabaciones.
- `lib/ewelink.js`: cuenta y control de dispositivos eWeLink.
- `tools/probe.js`: diagnóstico; conecta, lista códec y resolución por canal y guarda unos segundos de video.

## Limitaciones conocidas

- Las grabaciones se reproducen sin sonido.
- La velocidad rápida de grabaciones depende de lo que entregue el DVR (en la práctica, unas 2 o 3 veces el tiempo real).
- La hora impresa en la imagen puede diferir unos segundos de la línea de tiempo: son relojes distintos (cámara y DVR).
- No se puede hablar por el parlante ni manejar las luces todavía.
- Solo H.264. Las cámaras que transmitan en H.265 no se ven.
- En iPhone anterior a iOS 17.1 se usa HLS, con unos segundos de demora.

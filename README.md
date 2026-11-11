# Esee Visor

Mirá las cámaras de un DVR/NVR chino de los que usan la app **EseeCloud** (firmware Juan / dvr163, por ejemplo el K8210-3WS) desde la tele, el celular o la PC, dentro de tu red de casa y sin pasar por la nube.

Estos equipos no ofrecen RTSP ni ONVIF: solo hablan un protocolo propio ("kp2p") por WebSocket en el puerto 10000. Esee Visor es un servidor chico en Node.js que habla ese protocolo, convierte el video H.264 a MP4 fragmentado y lo muestra en una página web.

## Qué hace

- Grilla con todas las cámaras en vivo.
- Cámara a pantalla completa, en calidad baja o alta (HD).
- Movimiento (PTZ) y zoom, con botones en pantalla, teclado o control remoto.
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

## Seguridad

- Cualquiera conectado a tu red puede ver y mover las cámaras desde la página: no tiene clave propia.
- No abras el puerto 8080 a internet. Para ver las cámaras desde afuera usá una VPN (por ejemplo Tailscale o WireGuard).

## Archivos

- `server.js`: servidor web y manejo de canales.
- `lib/kp2p.js`: cliente del protocolo del DVR.
- `lib/fmp4.js`: empaquetador de H.264 a MP4 fragmentado.
- `public/index.html`: la página del visor.
- `tools/probe.js`: diagnóstico; conecta, lista códec y resolución por canal y guarda unos segundos de video.

## Limitaciones conocidas

- Sin audio por ahora (el DVR lo envía en G.711A).
- Sin reproducción de grabaciones.
- Solo H.264. Las cámaras que transmitan en H.265 no se ven.
- En iPhone anterior a iOS 17.1 se usa HLS, con unos segundos de demora.

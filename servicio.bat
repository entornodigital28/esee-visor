@echo off
rem Bucle del servidor para el modo oculto (lo lanza iniciar-oculto.vbs). Se detiene con detener.bat.
cd /d "%~dp0"
set ESEE_AUTOUPDATE=1
if exist detener.flag del detener.flag
:bucle
git pull --ff-only
node server.js
if exist detener.flag (del detener.flag & exit /b)
ping -n 6 127.0.0.1 >nul
goto bucle

@echo off
rem Inicia Esee Visor y lo mantiene actualizado desde GitHub.
rem Cuando hay una version nueva, el servidor se cierra solo y este bucle la baja y lo vuelve a iniciar.
cd /d "%~dp0"
set ESEE_AUTOUPDATE=1
:bucle
git pull --ff-only
node server.js
echo.
echo El servidor se detuvo. Reinicio en 5 segundos (Ctrl+C para salir)...
timeout /t 5 /nobreak >nul
goto bucle

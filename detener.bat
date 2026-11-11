@echo off
rem Detiene Esee Visor cuando corre oculto.
cd /d "%~dp0"
echo.> detener.flag
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":8080 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo Esee Visor detenido.
pause

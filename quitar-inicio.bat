@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EseeVisor.cmd" 2>nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EseeVisor.vbs" 2>nul
echo Listo: Esee Visor ya no arranca solo. Si esta corriendo, detenelo con detener.bat
pause

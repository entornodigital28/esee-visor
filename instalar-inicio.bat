@echo off
rem Hace que Esee Visor arranque solo y sin ventana al iniciar sesion en Windows, y lo inicia ahora.
set "INI=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
del "%INI%\EseeVisor.cmd" 2>nul
>"%INI%\EseeVisor.vbs" echo CreateObject("WScript.Shell").Run "wscript.exe ""%~dp0iniciar-oculto.vbs""", 0, False
wscript.exe "%~dp0iniciar-oculto.vbs"
echo Listo: Esee Visor quedo corriendo sin ventana y va a arrancar solo con Windows.
echo Para detenerlo: detener.bat   -   Para que no arranque solo: quitar-inicio.bat
pause

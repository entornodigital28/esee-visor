@echo off
rem Hace que Esee Visor arranque solo (minimizado) cuando iniciás sesión en Windows.
set "DEST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EseeVisor.cmd"
> "%DEST%" echo @echo off
>> "%DEST%" echo start "Esee Visor" /min cmd /c "%~dp0iniciar.bat"
echo Listo: Esee Visor va a arrancar solo al iniciar sesion en Windows.
echo Para deshacerlo, ejecuta quitar-inicio.bat
pause

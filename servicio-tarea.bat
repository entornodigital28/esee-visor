@echo off
rem Lo ejecuta la tarea de Windows "EseeVisor". Guarda la salida en servidor.log
cd /d "%~dp0"
rem sin ventana no se puede preguntar la clave de GitHub: si falta, que git falle en vez de quedar esperando
set GIT_TERMINAL_PROMPT=0
set GCM_INTERACTIVE=never
call servicio.bat > servidor.log 2>&1

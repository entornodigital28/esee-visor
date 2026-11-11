@echo off
rem Quita el arranque de Esee Visor al encender la PC y lo detiene.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0servicio.ps1" -Quitar

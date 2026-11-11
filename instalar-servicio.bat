@echo off
rem Hace que Esee Visor arranque al encender la PC, sin esperar a que alguien inicie sesion.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0servicio.ps1"

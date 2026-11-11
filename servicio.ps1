# Instala o quita Esee Visor como tarea de Windows que arranca al encender la PC,
# sin esperar a que alguien inicie sesion. Se usa desde instalar-servicio.bat y quitar-servicio.bat.
# (Sin acentos a proposito: Windows PowerShell 5 los lee mal en archivos sin BOM.)
param([switch]$Quitar, [string]$Usuario = "$env:USERDOMAIN\$env:USERNAME")
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tarea = 'EseeVisor'

# Hace falta ser administrador: si no lo somos, se vuelve a abrir pidiendo permiso
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $a = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Usuario `"$Usuario`""
  if ($Quitar) { $a += ' -Quitar' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $a
  exit
}

function Detener {
  Set-Content -Path (Join-Path $dir 'detener.flag') -Value 'x'
  Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 8
  Remove-Item (Join-Path $dir 'detener.flag') -ErrorAction SilentlyContinue
}

try {
  if ($Quitar) {
    Detener
    Unregister-ScheduledTask -TaskName $tarea -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'Listo: Esee Visor ya no arranca con la PC y quedo detenido.'
  } else {
    Write-Host "Esee Visor va a arrancar al encender la PC, con el usuario $Usuario."
    Write-Host ''
    Write-Host 'Para que funcione sin iniciar sesion, Windows necesita la clave de ese usuario.'
    Write-Host 'Es la clave de la cuenta (no el PIN de Windows). No se guarda en ningun archivo: la guarda Windows.'
    Write-Host 'Si la cuenta no tiene clave, deja vacio y presiona Enter: se usara la cuenta del sistema'
    Write-Host '(en ese caso el servidor funciona igual, pero no se actualiza solo desde GitHub).'
    Write-Host ''
    $sec = Read-Host -AsSecureString "Clave de Windows de $Usuario"
    $clave = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

    $accion = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c servicio-tarea.bat' -WorkingDirectory $dir
    $inicio = New-ScheduledTaskTrigger -AtStartup
    $ajustes = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

    Detener
    Unregister-ScheduledTask -TaskName $tarea -Confirm:$false -ErrorAction SilentlyContinue
    if ($clave) {
      Register-ScheduledTask -TaskName $tarea -Action $accion -Trigger $inicio -Settings $ajustes -User $Usuario -Password $clave -RunLevel Limited | Out-Null
    } else {
      Register-ScheduledTask -TaskName $tarea -Action $accion -Trigger $inicio -Settings $ajustes -User 'SYSTEM' -RunLevel Highest | Out-Null
    }
    $clave = $null

    # ya no hace falta el arranque al iniciar sesion
    $ini = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs\Startup'
    Remove-Item (Join-Path $ini 'EseeVisor.vbs'), (Join-Path $ini 'EseeVisor.cmd') -ErrorAction SilentlyContinue

    Start-ScheduledTask -TaskName $tarea
    Start-Sleep -Seconds 8
    if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) {
      Write-Host ''
      Write-Host 'Listo: Esee Visor esta corriendo y va a arrancar solo cada vez que se encienda la PC.'
    } else {
      Write-Host ''
      Write-Host 'La tarea quedo creada pero el servidor todavia no responde. Revisa servidor.log en la carpeta.'
    }
  }
} catch {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)"
  Write-Host 'Si dice que el usuario o la clave no son correctos, volve a ejecutar y revisa la clave.'
}
Write-Host ''
Read-Host 'Presiona Enter para cerrar'

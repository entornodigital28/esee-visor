' Inicia Esee Visor sin ventana. Lo que imprime el servidor queda en servidor.log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c """"" & dir & "\servicio.bat"" > """ & dir & "\servidor.log"" 2>&1""", 0, False

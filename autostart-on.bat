@echo off
rem Enable Windows Startup autostart for AGY Claude Style (agy-claude-style).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'AGY-Claude-Style.lnk';" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk);" ^
  "$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe';" ^
  "$s.Arguments = '\"%~dp0watch-hidden.vbs\" --keep-alive';" ^
  "$s.WorkingDirectory = '%~dp0'.TrimEnd('\');" ^
  "$s.Description = 'AGY Claude Style (agy-claude-style) watcher';" ^
  "$s.Save(); Write-Host ('Autostart enabled: ' + $lnk)"
pause

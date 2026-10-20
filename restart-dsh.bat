@echo off
rem ==========================================================================
rem  Double-click entry point for the restart helper.
rem  Use this when the Restart button is unavailable.
rem
rem  DRY RUN first (safe, kills nothing):  restart-dsh.bat --dry-run
rem  Real restart:                         restart-dsh.bat
rem
rem  IMPORTANT - why this file uses WMI instead of calling the helper directly:
rem    If this .bat is launched from a console INSIDE the app's process tree
rem    (e.g. a DSH terminal), a directly-started helper would be a descendant of
rem    the app root, so the tree kill would terminate the helper itself and the
rem    relaunch would never happen. Creating the helper through WMI puts it under
rem    WmiPrvSE.exe instead, which is outside that tree.
rem
rem  ASCII only on purpose: a .bat printed by cmd.exe is code-page dependent, so
rem  user-facing Chinese lives in README.md instead.
rem ==========================================================================
setlocal DisableDelayedExpansion
set "EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if not exist "%EXE%" (
  echo [ERROR] Desktop app not found at:
  echo         %EXE%
  echo         Edit the EXE line in this file, or use the plugin, which finds it automatically.
  pause
  exit /b 2
)

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "HELPER=%~dp0lib\restart-helper.ps1"
if not exist "%HELPER%" (
  echo [ERROR] Helper script not found at:
  echo         %HELPER%
  echo         Double-click this file from inside the plugin folder instead.
  pause
  exit /b 2
)

if /i "%~1"=="--dry-run" goto dryrun

echo Restarting DeepSeek Harness...
"%PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
  "$h = '%HELPER%'; $e = '%EXE%'; $log = Join-Path $env:TEMP ('dsh-desktop-restart\bat-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.log'); $cmd = ('\"{0}\" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{1}\" -RootPid 0 -Exe \"{2}\" -DelayMs 0 -LogFile \"{3}\" -ExpectApp' -f '%PS%', $h, $e, $log); $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }; if ($r.ReturnValue -ne 0) { exit 3 }; exit 0"
if errorlevel 1 (
  echo [ERROR] Could not launch the helper. See %TEMP%\dsh-desktop-restart\ for logs.
  pause
  exit /b %ERRORLEVEL%
)
rem No wait, no pause on the success path: the helper runs in its own hidden process, so
rem this window can close immediately. Leaving a console open here would just invite the
rem user to close it - and closing it used to be able to disturb the restart.
echo Done. DeepSeek Harness will close and reopen by itself in a few seconds.
echo Helper log: %TEMP%\dsh-desktop-restart\
exit /b 0

:dryrun
echo DRY RUN: showing the plan only. Nothing will be killed or started.
echo.
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -RootPid 0 -Exe "%EXE%" -DelayMs 0 -DryRun
echo.
echo (dry run finished)
pause
exit /b 0

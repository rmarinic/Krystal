@echo off
REM ============================================================
REM  KRYSTAL (Tauri) - build a standalone release executable.
REM
REM  Produces:  src-tauri\target\release\krystal.exe
REM  The whole UI is embedded in the .exe — copy it anywhere and
REM  double-click. (It still needs the `claude` CLI on PATH.)
REM
REM  To build a Windows INSTALLER (.msi / .exe setup) instead,
REM  install the Tauri CLI once:   cargo install tauri-cli --locked
REM  then run:                     cargo tauri build
REM ============================================================
cd /d "%~dp0src-tauri"
title KRYSTAL (Tauri) - release build
echo.
echo   Building release krystal.exe ...  (this takes a few minutes)
echo.
cargo build --release
if %errorlevel%==0 (
  echo.
  echo   Done. Your app:
  echo     %~dp0src-tauri\target\release\krystal.exe
  echo.
)
pause

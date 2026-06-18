@echo off
REM ============================================================
REM  KRYSTAL (Tauri) - run the desktop app in dev mode.
REM  Compiles (first run is slow) then launches the window.
REM ============================================================
cd /d "%~dp0src-tauri"
title KRYSTAL (Tauri) - dev
echo.
echo   Building and launching KRYSTAL...  (first build takes a few minutes)
echo.
cargo run

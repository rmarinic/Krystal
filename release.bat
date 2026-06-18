@echo off
REM ============================================================================
REM  release.bat <version>   e.g.   release.bat 0.2.0
REM
REM  Bumps the version in all three manifests, commits, tags v<version> and
REM  pushes. The push of the tag triggers .github/workflows/release.yml, which
REM  builds + signs the installer and publishes the GitHub Release. Installed
REM  copies then self-update on their next launch.
REM ============================================================================
setlocal

set "VER=%~1"
if "%VER%"=="" (
  echo Usage: release.bat ^<version^>   e.g.  release.bat 0.2.0
  exit /b 1
)

echo(%VER%| findstr /R "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo ERROR: version must look like  MAJOR.MINOR.PATCH  (e.g. 0.2.0^)
  exit /b 1
)

echo.
echo   Bumping Krystal to v%VER% ...

REM --- Bump the version in all three manifests (robust UTF-8, no BOM) ---
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bump-version.ps1" %VER%
if errorlevel 1 ( echo ERROR: version bump failed & exit /b 1 )
echo.

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v%VER%"
if errorlevel 1 ( echo ERROR: commit failed & exit /b 1 )

git tag "v%VER%"
if errorlevel 1 ( echo ERROR: tag v%VER% already exists? & exit /b 1 )

git push
git push origin "v%VER%"

echo.
echo   Pushed v%VER%. GitHub Actions is now building the release.
echo   Watch it at:  https://github.com/rmarinic/Krystal/actions
echo.
endlocal

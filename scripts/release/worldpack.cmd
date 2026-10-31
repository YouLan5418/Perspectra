@echo off
setlocal
if /i "%~1"=="lens" goto lens
"%~dp0runtime\node.exe" --disable-warning=ExperimentalWarning "%~dp0runtime\worldpack.mjs" %*
exit /b %errorlevel%
:lens
shift /1
rem The bundled host finds its frontend assets and memory code under this folder.
set "PERSPECTRA_RUNTIME_ROOT=%~dp0runtime"
"%~dp0runtime\node.exe" --disable-warning=ExperimentalWarning "%~dp0runtime\lens.mjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%

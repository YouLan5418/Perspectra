@echo off
setlocal
set "PERSPECTRA_RUNTIME_ROOT=%~dp0runtime"
"%~dp0runtime\node.exe" --disable-warning=ExperimentalWarning "%~dp0runtime\worldpack.mjs" %*
exit /b %errorlevel%

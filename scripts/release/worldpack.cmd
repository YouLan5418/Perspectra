@echo off
setlocal
"%~dp0runtime\node.exe" --disable-warning=ExperimentalWarning "%~dp0runtime\worldpack.mjs" %*
exit /b %errorlevel%

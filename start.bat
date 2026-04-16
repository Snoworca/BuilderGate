@echo off
setlocal

set SCRIPT_DIR=%~dp0
node "%SCRIPT_DIR%tools\start-runtime.js" %*
set EXIT_CODE=%ERRORLEVEL%

endlocal & exit /b %EXIT_CODE%

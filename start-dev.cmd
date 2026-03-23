@echo off
setlocal
pushd "%~dp0"
call npm.cmd run dev
set EXIT_CODE=%ERRORLEVEL%
popd
exit /b %EXIT_CODE%

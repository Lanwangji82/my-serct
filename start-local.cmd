@echo off
setlocal
pushd "%~dp0"
start "Binance Proxy" "%~dp0start-proxy.cmd"
start "QuantX Dev" "%~dp0start-dev.cmd"
popd
exit /b 0

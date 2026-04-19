@echo off
chcp 65001 >nul
color 0A
echo ===================================================
echo   CDP Port Forwarding Setup (Admin Rights Required)
echo ===================================================
echo.

REM Check for administrator rights
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [+] Administrator rights confirmed.
) else (
    echo [!] Requesting Administrator rights...
    powershell -Command "Start-Process '%~0' -Verb RunAs"
    exit /b
)

echo.
echo [+] Determining local IP address...
REM Get the IP address of the active default network route
for /f "usebackq tokens=*" %%i in (`powershell -Command "(Get-NetIPAddress -InterfaceIndex (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex -AddressFamily IPv4).IPAddress"`) do set "IP=%%i"

if "%IP%"=="" (
    echo [-] Failed to determine IP address. Make sure you are connected to a network.
    pause
    exit /b 1
)

echo [+] Found IP: %IP%

echo.
set "PORT=9222"
set /p PORT="Enter port number (default 9222): "

echo.
echo [+] Setting up port forwarding (%PORT% -^> 127.0.0.1:%PORT%)...
netsh interface portproxy add v4tov4 listenport=%PORT% listenaddress=%IP% connectport=%PORT% connectaddress=127.0.0.1

echo.
echo [+] Configuring Windows Firewall...
powershell -Command "New-NetFirewallRule -DisplayName 'Allow CDP Remote Debugging' -Direction Inbound -LocalPort %PORT% -Protocol TCP -Action Allow -ErrorAction SilentlyContinue"

echo.
echo ===================================================
echo [SUCCESS] CDP port forwarding is set up!
echo Your CDP is now accessible at: http://%IP%:%PORT%
echo ===================================================
pause

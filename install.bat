@echo off
setlocal

REM Directory where Antigravity IDE extensions are installed
set DEST="%USERPROFILE%\.antigravity\extensions\auto-retry-plugin"

echo [1/3] Compiling plugin...
call npm run compile

echo.
echo [2/3] Removing old version from extensions...
if exist %DEST% rmdir /s /q %DEST%

echo.
echo [3/3] Copying files to %DEST%...
REM Copying everything except files in exclude.txt
xcopy /s /e /i /y /exclude:exclude.txt . %DEST%

echo.
echo ==============================================
echo Installation successfully completed!
echo Please completely restart your IDE (VS Code / Antigravity)
echo to load the plugin.
echo ==============================================
pause

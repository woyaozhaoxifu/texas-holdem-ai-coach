@echo off
chcp 65001 >nul
title 德州扑克 AI 对战
cd /d "%~dp0"
set PORT=8790

echo ============================================
echo   德州扑克 AI 对战 · 教学复盘版
echo ============================================

where python >nul 2>nul
if errorlevel 1 goto nopython

echo [1/3] 正在启动本地服务器 (端口 %PORT%) ...
powershell -NoProfile -Command "$p = Start-Process python -ArgumentList '-m','http.server','%PORT%' -WindowStyle Hidden -PassThru; $p.Id | Out-File -Encoding ascii '%~dp0server.pid'" >nul 2>nul
timeout /t 2 /nobreak >nul

echo [2/3] 正在打开浏览器 ...
start "" "http://localhost:%PORT%/index.html"

echo [3/3] 完成！
echo.
echo   - 若浏览器未能打开，请手动访问:  http://localhost:%PORT%/index.html
echo   - 也可以直接双击 index.html 文件（离线也能玩）
echo   - 本窗口不要关闭，关闭会自动停止服务
echo.
pause >nul

if exist "%~dp0server.pid" (
  set /p SERVERPID=<"%~dp0server.pid"
  taskkill /pid %SERVERPID% /f >nul 2>nul
  del "%~dp0server.pid" >nul 2>nul
)
exit /b

:nopython
echo [提示] 未检测到 python，改用直接打开文件方式（完全离线可用）。
start "" "index.html"
exit /b

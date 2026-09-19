@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 寂零快跑

echo.
echo   ============================================
echo      寂零快跑   一键启动
echo   ============================================
echo.

if not exist "index.html" (
  echo   出错：找不到 index.html
  echo   请把本脚本和游戏文件放在同一个文件夹里，再双击运行。
  echo.
  pause
  exit /b
)

rem 不需要装任何东西，浏览器直接打开本地文件就能玩。
rem 优先用 Edge / Chrome，没有就用系统默认浏览器。
set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

echo   正在打开游戏……
echo.

if defined BROWSER (
  start "" "%BROWSER%" "%~dp0index.html"
) else (
  start "" "%~dp0index.html"
)

echo   已经交给浏览器了。
echo.
echo   如果没弹出，手动双击文件夹里的 index.html 也一样能玩。
echo   如果浏览器问"是否允许打开此文件"，选"允许"。
echo.
ping -n 6 127.0.0.1 >nul
exit /b

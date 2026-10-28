@echo off
rem Nexent 支撑资源手动同步入口（双击运行）
cd /d D:\projects\feishu
node scripts\sync\sync-all.mjs %*
echo.
pause

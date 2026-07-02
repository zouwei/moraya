@echo off
cd /d "%~dp0"
echo Starting Moraya dev server...
call npm run dev
pause

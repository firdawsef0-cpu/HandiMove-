@echo off
cd /d "%~dp0"
echo Dossier : %cd%
where node >nul 2>nul || (echo Node.js est introuvable. Installez-le depuis https://nodejs.org & pause & exit /b 1)
start "" http://127.0.0.1:3000
node server.js
pause

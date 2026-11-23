@echo off
rem Avvia KeepCrawl su Windows con un doppio clic.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js non e' installato. Scaricalo da https://nodejs.org ^(versione LTS^), installalo e riprova.
  start https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
  echo Serve Node.js 22 o piu' recente. Aggiornalo da https://nodejs.org e riprova.
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist .env if exist .env.example copy .env.example .env >nul
echo Avvio KeepCrawl... lascia aperta questa finestra. Per chiuderlo premi Ctrl+C.
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:3100"
call npm start
pause

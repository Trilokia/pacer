@echo off
rem Double-click this file to start Pacer and open it in your browser.
rem Keep the window open: closing it stops Pacer and any agents it started.
cd /d "%~dp0"
node server.js --open
if errorlevel 1 pause

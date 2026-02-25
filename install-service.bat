@echo off
echo Creating Cursor Hub startup task...
schtasks /create /tn "CursorHub" /tr "node \"%~dp0server.js\"" /sc onlogon /rl highest /f
echo.
echo Done! Cursor Hub will now start automatically when you log in.
echo To remove: schtasks /delete /tn "CursorHub" /f
pause

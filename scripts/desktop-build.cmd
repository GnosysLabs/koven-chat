@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" || exit /b 1
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
bun run desktop:build
exit /b %ERRORLEVEL%

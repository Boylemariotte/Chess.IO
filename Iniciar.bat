@echo off
title Ajedrez - Analiza y Juega
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo No se encontro Python. Instala Python 3 desde https://www.python.org/downloads/
  echo Recuerda marcar "Add Python to PATH" durante la instalacion.
  pause
  exit /b
)
echo Iniciando... el navegador se abrira solo en unos segundos.
py app.py
echo.
echo El programa se ha detenido. Pulsa una tecla para cerrar.
pause >nul

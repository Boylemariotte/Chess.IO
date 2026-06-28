@echo off
title Ajedrez Web (estatico)
cd /d "%~dp0web"
echo Sirviendo la version web en http://localhost:8000
echo (Cierra esta ventana para detener.)
start "" http://localhost:8000/engine_test.html
py -m http.server 8000

@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND_PY=%ROOT%backend\.venv\Scripts\python.exe"
set "REFOCUS_TTS_ROOT=%ROOT%local-tts"
set "REFOCUS_TTS_PY=%REFOCUS_TTS_ROOT%\python\python.exe"
set "REFOCUS_TTS_SERVER=%REFOCUS_TTS_ROOT%\tts_server.py"

if exist "%REFOCUS_TTS_PY%" (
  echo Starting optional local speech service if needed...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference = 'SilentlyContinue'; function Test-TtsHealth { try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8767/health' -TimeoutSec 1; return [bool]$response.ok } catch { return $false } }; if (-not (Test-TtsHealth)) { Start-Process -FilePath $env:REFOCUS_TTS_PY -ArgumentList @('-u', $env:REFOCUS_TTS_SERVER) -WorkingDirectory $env:REFOCUS_TTS_ROOT -WindowStyle Hidden }; $deadline = (Get-Date).AddSeconds(10); while ((Get-Date) -lt $deadline -and -not (Test-TtsHealth)) { Start-Sleep -Milliseconds 500 }; if (Test-TtsHealth) { Write-Host 'Optional local speech service is ready.' } else { Write-Host 'Optional local speech service is unavailable; browser speech remains available.' }"
) else (
  echo Optional local speech runtime not found; browser speech remains available.
)

if not exist "%BACKEND_PY%" (
  echo Backend virtual environment not found: "%BACKEND_PY%"
  exit /b 1
)

echo Starting Learning Companion at http://127.0.0.1:8000/
pushd "%ROOT%backend"
start "Learning Companion API" /B "%BACKEND_PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
popd
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'SilentlyContinue'; function Test-AppHealth { try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 1; return $response.status -eq 'ok' } catch { return $false } }; $deadline = (Get-Date).AddSeconds(15); while ((Get-Date) -lt $deadline -and -not (Test-AppHealth)) { Start-Sleep -Milliseconds 250 }; if (-not (Test-AppHealth)) { exit 1 }"
if errorlevel 1 (
  echo Refocus did not become ready. Check that port 8000 is available and try again.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8000/"

endlocal

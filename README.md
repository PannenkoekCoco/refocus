# Refocus

Refocus adds independently testable Node and Python tooling around the existing EMA Cram Trainer and its local TTS source.

## Bootstrap

From this directory, run:

```powershell
py -3.12 -m venv backend/.venv
backend\.venv\Scripts\python.exe -m pip install -e "backend[dev]"
npm.cmd install
npx.cmd playwright install chromium
```

Copy `.env.example` to `.env` and provide local values for the documented variables. Do not commit `.env`.

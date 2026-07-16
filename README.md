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

## Optional GitHub mission verification

Refocus uses a GitHub App user-to-server authorization flow, not a GitHub OAuth App. Before enabling it in a deployed environment:

- Enable user authorization and set the callback URL to `${APP_ORIGIN}/api/auth/github/callback`.
- Choose **Only select repositories**, disable webhooks, and request only read access to Metadata, Contents, Pull requests, Checks, and Commit statuses.
- Put the app ID, client ID, client secret, and PEM private key in deployment secrets using the `GITHUB_*` variables in `.env.example`. Never commit real values.
- Enterprise installations are intentionally excluded because GitHub cannot scope their installation tokens to one repository.

The server keeps only a short-lived callback transaction, a stable GitHub user ID, and a snapshot of selectable repositories. It never stores browser-facing or GitHub access tokens. Repository verification requires a fresh GitHub authorization (15 minutes by default), has a per-user cooldown, and uses fixed-host, read-only requests only. The local launcher disables Uvicorn access logs because callback URLs can contain OAuth values; any reverse proxy must likewise redact query strings for `/api/auth/github/callback` and respect its no-store response headers.

An existing signed-in Refocus user is linked through the short-lived OAuth transaction to the stable GitHub ID, preserving that user’s learning data without comparing mutable GitHub logins. If no current Refocus session is available, Refocus deliberately does not infer an account merge from a GitHub username.

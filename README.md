# Refocus

Refocus is a customizable, practical engineering learning route. Every topic remains selectable; pins and focus lenses shape the recommendation without locking the route. Full lessons, quizzes, missions, and all learner-facing guidance keep a text-to-speech path: the optional local voice service is used when available and browser speech is the fallback.

## Start locally

From this directory, create the local development environment and install the browser test dependency:

```powershell
py -3.12 -m venv backend/.venv
backend\.venv\Scripts\python.exe -m pip install -e "backend[dev]"
npm.cmd ci
npx.cmd playwright install chromium
```

Copy `.env.example` to `.env` for local settings. Do not commit `.env` or any real credentials.

On Windows, start the supported Refocus entrypoint with `Launch Learning Companion.cmd`. It starts the FastAPI app at [http://127.0.0.1:8000/](http://127.0.0.1:8000/). The compatibility `Launch EMA Cram Trainer.cmd` delegates to that same launcher; it no longer starts an EMA-only page.

To start only the web app manually:

```powershell
Push-Location backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
Pop-Location
```

Use `GET /health` at [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health) to check the service. It returns `200` with `{"status":"ok"}` when the app is ready.

### Optional local TTS

The portable local TTS runtime is intentionally not committed or included in the Docker image. If `local-tts/python/python.exe` exists, `Launch Learning Companion.cmd` attempts to start the local service at `127.0.0.1:8767`; otherwise Refocus continues with browser speech. Browser speech is also used if a local TTS request fails. Treat local WAV generation as a manual machine-specific check rather than a release guarantee.

## Quality checks

Run the browser suite through the same FastAPI entrypoint learners use:

```powershell
npm.cmd run test:unit
npm.cmd run test:e2e
backend\.venv\Scripts\python.exe -m pytest backend/tests -q
backend\.venv\Scripts\python.exe -m compileall backend/app
backend\.venv\Scripts\python.exe -m pip check
```

The Playwright server waits for `GET /health` on port 8000. On Windows it uses `backend\.venv\Scripts\python.exe` when present. Linux CI uses `python3` by default; set `REFOCUS_TEST_PYTHON` to an exact interpreter path when needed.

Browser acceptance tests intentionally mock browser-level progress, focus-lens, and GitHub routes so they do not require local PostgreSQL or GitHub credentials. Backend tests cover persistence, ownership, authorization, and redaction separately.

## Local container workflow

The default image runs only the web service as the non-root `refocus` user. It does not bundle the optional local TTS runtime and it does not run migrations at web-process boot.

For local container development, Docker Compose starts PostgreSQL, runs the one-off `migrate` service, and then starts the app bound to `127.0.0.1:8000`:

```powershell
docker compose up --build
```

The Compose credentials are development-only placeholders. Production startup rejects the committed session placeholder, so Docker Desktop is required for this command and it is not a substitute for a production deployment. Docker/Compose remains an external manual check on machines without Docker Desktop; do not substitute SQLite for that check.

## Production deployment checklist

Deployment intentionally waits for a user-selected Docker-compatible provider and that provider's credentials. Before releasing Refocus:

- Provision managed PostgreSQL and set `DATABASE_URL` to its `postgresql+psycopg://` connection URL. Do not use the local Compose database or SQLite.
- Set `APP_ENVIRONMENT=production`, use an HTTPS root `APP_ORIGIN` (for example `https://learn.example.com`), and terminate TLS at the chosen provider or a configured edge.
- Set a unique, high-entropy `SESSION_SECRET` from a secret generator; production requires at least 32 characters and rejects the repository's development/CI placeholders plus obvious repeated patterns. That validation is a safety net, not a substitute for generating a real secret. Production cookies are HttpOnly, `SameSite=Lax`, and Secure.
- GitHub verification is optional. Leave every `GITHUB_*` value unset to deploy the core learning app without it; `/api/auth/github/login` then safely returns `github_not_configured`. To enable verification, configure the GitHub App with the exact callback URL `${APP_ORIGIN}/api/auth/github/callback`, then set all of `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_PRIVATE_KEY` together as provider secrets. Production rejects partial GitHub configuration. Keep the read-only permissions described below and do not enable webhooks.
- Run `alembic upgrade head` once as the provider's pre-deploy migration step against the managed database, before web instances scale up. Do not run migrations on every web boot.
- Deploy the Docker image with its default web command, configure the provider health check for `GET /health`, and verify it returns `200` with `{"status":"ok"}` after release.
- Configure edge/WAF request limits and query-string redaction for operational logs. Refocus does not claim to provide a process-local production rate limiter.

The app emits JSON request events containing only an event name, canonical request ID, method, path without its query string, status, and duration. Uvicorn access logs are disabled in the launcher and image so callback query values cannot bypass that policy. Do not enable untrusted forwarded-header handling unless the chosen provider gives you a bounded trusted-proxy configuration.

## Optional GitHub mission verification

Refocus uses a GitHub App user-to-server authorization flow, not a GitHub OAuth App. Before enabling it in a deployed environment:

- Enable user authorization and set the callback URL to `${APP_ORIGIN}/api/auth/github/callback`.
- Choose **Only select repositories**, disable webhooks, and request only read access to Metadata, Contents, Pull requests, Checks, and Commit statuses.
- Put the app ID, client ID, client secret, and PEM private key in deployment secrets using the `GITHUB_*` variables in `.env.example`. Never commit real values.
- Enterprise installations are intentionally excluded because GitHub cannot scope their installation tokens to one repository.

The server keeps only a short-lived callback transaction, a stable GitHub user ID, and a snapshot of selectable repositories. It never stores browser-facing or GitHub access tokens. Repository verification requires a fresh GitHub authorization (15 minutes by default), has a per-user cooldown, and uses fixed-host, read-only requests only. The launcher and image disable Uvicorn access logs because callback URLs can contain OAuth values; any reverse proxy must likewise redact query strings for `/api/auth/github/callback` and respect its no-store response headers.

An existing signed-in Refocus user is linked through the short-lived OAuth transaction to the stable GitHub ID, preserving that user's learning data without comparing mutable GitHub logins. If no current Refocus session is available, Refocus deliberately does not infer an account merge from a GitHub username.

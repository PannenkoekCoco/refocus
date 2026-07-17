import hmac
from datetime import timedelta
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.exc import IntegrityError

from app.dependencies import (
    DatabaseSession,
    SettingsDependency,
    WriteCurrentSession,
    get_current_user,
)
from app.models import Session, User, utcnow
from app.schemas import (
    AnonymousMeResponse,
    AuthenticatedMeResponse,
    GithubConnectionBusyResponse,
    GithubNotConfiguredResponse,
    UserView,
)
from app.security.sessions import (
    github_transaction_cookie_kwargs,
    new_session_token,
    session_cookie_kwargs,
)
from app.services.github_client import (
    GITHUB_AUTHORIZE_URL,
    GitHubClient,
    GitHubClientError,
    run_with_github_operation_deadline,
)
from app.services.github_connections import (
    consume_oauth_transaction,
    create_oauth_transaction,
    discard_oauth_transaction,
    github_authorization_is_fresh,
    new_oauth_transaction_secrets,
    OAuthTransactionLimitError,
    persist_authorization_snapshot,
)


router = APIRouter()


def _github_callback_redirect(settings: SettingsDependency) -> RedirectResponse:
    response = RedirectResponse(settings.github_return_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    cookie_kwargs = github_transaction_cookie_kwargs(settings)
    delete_cookie_kwargs = {
        key: cookie_kwargs[key]
        for key in ("httponly", "samesite", "secure", "path")
    }
    response.delete_cookie(settings.github_oauth_state_cookie_name, **delete_cookie_kwargs)
    response.delete_cookie(settings.github_pkce_cookie_name, **delete_cookie_kwargs)
    return response


def _is_ascii_secret(value: str | None, max_length: int) -> bool:
    return bool(value) and len(value) <= max_length and value.isascii()


def _github_client(request: Request, settings: SettingsDependency):
    factory = getattr(request.app.state, "github_client_factory", GitHubClient)
    return factory(settings)


@router.get("/me", response_model=AnonymousMeResponse | AuthenticatedMeResponse)
async def me(
    current_user: Annotated[User | None, Depends(get_current_user)],
    settings: SettingsDependency,
) -> AnonymousMeResponse | AuthenticatedMeResponse:
    if current_user is None:
        return AnonymousMeResponse()
    return AuthenticatedMeResponse(
        user=UserView(
            id=current_user.id,
            github_connected=github_authorization_is_fresh(
                current_user,
                max_age_seconds=settings.github_authorization_max_age_seconds,
            ),
        )
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    current_session: WriteCurrentSession,
    database: DatabaseSession,
) -> Response:
    current_session.session.revoked_at = utcnow()
    await database.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/auth/github/login",
    responses={
        status.HTTP_429_TOO_MANY_REQUESTS: {"model": GithubConnectionBusyResponse},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"model": GithubNotConfiguredResponse},
    },
)
async def github_login(
    request: Request,
    settings: SettingsDependency,
    database: DatabaseSession,
    current_user: Annotated[User | None, Depends(get_current_user)],
) -> Response:
    if not settings.github_is_configured:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content=GithubNotConfiguredResponse(code="github_not_configured").model_dump(),
        )
    transaction = new_oauth_transaction_secrets()
    try:
        await create_oauth_transaction(
            database,
            state=transaction.state,
            max_age_seconds=settings.github_oauth_max_age_seconds,
            user_id=current_user.id if current_user is not None else None,
            previous_state=request.cookies.get(settings.github_oauth_state_cookie_name),
            max_pending_transactions=settings.github_oauth_max_pending_transactions,
        )
    except OAuthTransactionLimitError:
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content=GithubConnectionBusyResponse(code="github_connection_busy").model_dump(),
        )
    authorization_query = urlencode(
        {
            "client_id": settings.github_client_id,
            "redirect_uri": settings.github_callback_url,
            "state": transaction.state,
            "code_challenge": transaction.code_challenge,
            "code_challenge_method": "S256",
        }
    )
    response = RedirectResponse(
        f"{GITHUB_AUTHORIZE_URL}?{authorization_query}",
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    cookie_kwargs = github_transaction_cookie_kwargs(settings)
    response.set_cookie(settings.github_oauth_state_cookie_name, transaction.state, **cookie_kwargs)
    response.set_cookie(settings.github_pkce_cookie_name, transaction.code_verifier, **cookie_kwargs)
    return response


@router.get("/auth/github/callback")
async def github_callback(
    request: Request,
    settings: SettingsDependency,
    database: DatabaseSession,
    current_user: Annotated[User | None, Depends(get_current_user)],
) -> RedirectResponse:
    response = _github_callback_redirect(settings)
    if not settings.github_is_configured:
        return response

    state = request.query_params.get("state")
    code = request.query_params.get("code")
    cookie_state = request.cookies.get(settings.github_oauth_state_cookie_name)
    code_verifier = request.cookies.get(settings.github_pkce_cookie_name)
    if not all((
        _is_ascii_secret(state, max_length=512),
        _is_ascii_secret(cookie_state, max_length=512),
        _is_ascii_secret(code_verifier, max_length=128),
        _is_ascii_secret(code, max_length=2_048),
    )):
        return response
    if not hmac.compare_digest(state, cookie_state):
        return response
    transaction = await consume_oauth_transaction(database, state=state)
    if transaction is None:
        return response
    if transaction.user_id != (current_user.id if current_user is not None else None):
        await discard_oauth_transaction(database, transaction_id=transaction.id)
        return response
    raw_session_token: str | None = None
    try:
        snapshot = await run_with_github_operation_deadline(
            _github_client(request, settings).authorization_snapshot(
                code=code,
                code_verifier=code_verifier,
            ),
            timeout_seconds=settings.github_callback_timeout_seconds,
        )
        user = await persist_authorization_snapshot(
            database,
            snapshot=snapshot,
            local_user_id=transaction.user_id,
            transaction_id=transaction.id,
        )
        if transaction.user_id is None:
            raw_session_token, session_token_hash = new_session_token()
            database.add(
                Session(
                    user_id=user.id,
                    token_hash=session_token_hash,
                    expires_at=utcnow() + timedelta(seconds=settings.session_max_age_seconds),
                )
            )
            await database.commit()
    except (GitHubClientError, IntegrityError, TimeoutError, ValueError):
        await database.rollback()
        await discard_oauth_transaction(database, transaction_id=transaction.id)
        return response

    if raw_session_token is not None:
        response.set_cookie(
            settings.session_cookie_name,
            raw_session_token,
            **session_cookie_kwargs(settings),
        )
    await discard_oauth_transaction(database, transaction_id=transaction.id)
    return response

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, timedelta
from uuid import UUID

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    GitHubInstallation,
    GitHubOAuthTransaction,
    GitHubRepository,
    MissionVerification,
    User,
    utcnow,
)
from app.services.github_client import AuthorizationSnapshot
from app.services.github_verifier import VerificationResult


@dataclass(frozen=True)
class OAuthTransactionSecrets:
    state: str
    code_verifier: str
    code_challenge: str


@dataclass(frozen=True)
class OAuthTransactionConsumption:
    id: UUID
    user_id: UUID | None


class OAuthTransactionLimitError(Exception):
    """The bounded OAuth transaction store is temporarily full."""


def new_oauth_transaction_secrets() -> OAuthTransactionSecrets:
    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode("ascii")).digest()
    ).decode("ascii").rstrip("=")
    return OAuthTransactionSecrets(
        state=state,
        code_verifier=code_verifier,
        code_challenge=code_challenge,
    )


def oauth_state_hash(state: str) -> str:
    return hashlib.sha256(state.encode("utf-8")).hexdigest()


async def create_oauth_transaction(
    database: AsyncSession,
    *,
    state: str,
    max_age_seconds: int,
    user_id: UUID | None,
    previous_state: str | None,
    max_pending_transactions: int,
) -> None:
    now = utcnow()
    await database.execute(
        delete(GitHubOAuthTransaction).where(GitHubOAuthTransaction.expires_at <= now)
    )
    if previous_state is not None and len(previous_state) <= 512:
        await database.execute(
            delete(GitHubOAuthTransaction).where(
                GitHubOAuthTransaction.state_hash == oauth_state_hash(previous_state)
            )
        )
    pending_transactions = (
        await database.execute(
            select(func.count(GitHubOAuthTransaction.id)).where(
                GitHubOAuthTransaction.expires_at > now,
                GitHubOAuthTransaction.consumed_at.is_(None),
            )
        )
    ).scalar_one()
    if pending_transactions >= max_pending_transactions:
        await database.commit()
        raise OAuthTransactionLimitError()
    database.add(
        GitHubOAuthTransaction(
            user_id=user_id,
            state_hash=oauth_state_hash(state),
            expires_at=now + timedelta(seconds=max_age_seconds),
        )
    )
    await database.commit()


async def consume_oauth_transaction(
    database: AsyncSession,
    *,
    state: str,
) -> OAuthTransactionConsumption | None:
    now = utcnow()
    result = await database.execute(
        update(GitHubOAuthTransaction)
        .where(
            GitHubOAuthTransaction.state_hash == oauth_state_hash(state),
            GitHubOAuthTransaction.expires_at > now,
            GitHubOAuthTransaction.consumed_at.is_(None),
        )
        .values(consumed_at=now)
    )
    if result.rowcount != 1:
        await database.rollback()
        return None
    transaction = (
        await database.execute(
            select(GitHubOAuthTransaction.id, GitHubOAuthTransaction.user_id).where(
                GitHubOAuthTransaction.state_hash == oauth_state_hash(state)
            )
        )
    ).one()
    await database.commit()
    return OAuthTransactionConsumption(id=transaction.id, user_id=transaction.user_id)


def github_authorization_is_fresh(user: User, *, max_age_seconds: int) -> bool:
    authorized_at = user.github_authorized_at
    if user.github_user_id is None or authorized_at is None:
        return False
    if authorized_at.tzinfo is None:
        authorized_at = authorized_at.replace(tzinfo=UTC)
    return authorized_at > utcnow() - timedelta(seconds=max_age_seconds)


async def _locked_user(database: AsyncSession, user_id: UUID) -> User | None:
    return (
        await database.execute(
            select(User)
            .where(User.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def reserve_github_verification(
    database: AsyncSession,
    *,
    user_id: UUID,
    minimum_interval_seconds: int,
) -> bool:
    """Atomically limit one user's expensive GitHub evidence checks."""
    now = utcnow()
    statement = (
        update(User)
        .where(
            User.id == user_id,
            User.github_user_id.is_not(None),
            or_(
                User.github_verification_started_at.is_(None),
                User.github_verification_started_at <= now - timedelta(seconds=minimum_interval_seconds),
            ),
        )
        .values(github_verification_started_at=now)
        .execution_options(synchronize_session=False)
    )
    result = await database.execute(statement)
    if result.rowcount != 1:
        await database.rollback()
        return False
    await database.commit()
    return True


async def persist_authorization_snapshot(
    database: AsyncSession,
    *,
    snapshot: AuthorizationSnapshot,
    local_user_id: UUID | None,
    transaction_id: UUID,
) -> User:
    local_user = None
    if local_user_id is not None:
        local_user = await _locked_user(database, local_user_id)
        if local_user is None:
            raise ValueError("The initiating Refocus account is unavailable")
        if local_user.github_user_id not in {
            None,
            snapshot.github_user_id,
        }:
            raise ValueError("Local account is already connected to another GitHub user")
    transaction_is_current = (
        await database.execute(
            select(GitHubOAuthTransaction.id)
            .where(
                GitHubOAuthTransaction.id == transaction_id,
                GitHubOAuthTransaction.consumed_at.is_not(None),
                GitHubOAuthTransaction.expires_at > utcnow(),
                (
                    GitHubOAuthTransaction.user_id == local_user_id
                    if local_user_id is not None
                    else GitHubOAuthTransaction.user_id.is_(None)
                ),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if transaction_is_current is None:
        raise ValueError("The GitHub authorization transaction is no longer active")
    stable_user = (
        await database.execute(
            select(User).where(User.github_user_id == snapshot.github_user_id).limit(1)
        )
    ).scalar_one_or_none()
    if stable_user is not None and local_user is not None and stable_user.id != local_user.id:
        raise ValueError("GitHub user is already connected to another local account")
    user = local_user if local_user is not None else stable_user
    if user is None:
        user = User(github_user_id=snapshot.github_user_id)
        database.add(user)
        await database.flush()

    user.github_user_id = snapshot.github_user_id
    user.github_authorized_at = utcnow()
    user.github_verification_started_at = None

    await database.execute(delete(MissionVerification).where(MissionVerification.user_id == user.id))
    installation_ids = select(GitHubInstallation.id).where(GitHubInstallation.user_id == user.id)
    await database.execute(
        delete(GitHubRepository).where(GitHubRepository.installation_id.in_(installation_ids))
    )
    await database.execute(delete(GitHubInstallation).where(GitHubInstallation.user_id == user.id))

    for installation_snapshot in snapshot.installations:
        installation = GitHubInstallation(
            user_id=user.id,
            github_installation_id=installation_snapshot.installation_id,
            account_login=installation_snapshot.account_login,
        )
        database.add(installation)
        await database.flush()
        for repository_snapshot in installation_snapshot.repositories:
            database.add(
                GitHubRepository(
                    user_id=user.id,
                    installation_id=installation.id,
                    github_repository_id=repository_snapshot.repository_id,
                    full_name=repository_snapshot.full_name,
                    default_branch=repository_snapshot.default_branch,
                    is_selected=False,
                )
            )
    await database.commit()
    return user


async def list_installations(
    database: AsyncSession,
    *,
    user_id: UUID,
) -> list[tuple[GitHubInstallation, list[GitHubRepository]]]:
    installations = (
        await database.execute(
            select(GitHubInstallation)
            .where(GitHubInstallation.user_id == user_id)
            .order_by(GitHubInstallation.github_installation_id)
        )
    ).scalars().all()
    if not installations:
        return []
    installation_ids = [installation.id for installation in installations]
    repositories = (
        await database.execute(
            select(GitHubRepository)
            .where(
                GitHubRepository.user_id == user_id,
                GitHubRepository.installation_id.in_(installation_ids),
            )
            .order_by(GitHubRepository.full_name)
        )
    ).scalars().all()
    repositories_by_installation = {installation_id: [] for installation_id in installation_ids}
    for repository in repositories:
        repositories_by_installation.setdefault(repository.installation_id, []).append(repository)
    return [
        (installation, repositories_by_installation[installation.id])
        for installation in installations
    ]


async def get_owned_repository(
    database: AsyncSession,
    *,
    user_id: UUID,
    github_repository_id: int,
) -> tuple[GitHubRepository, GitHubInstallation] | None:
    result = await database.execute(
        select(GitHubRepository, GitHubInstallation)
        .join(GitHubInstallation, GitHubRepository.installation_id == GitHubInstallation.id)
        .where(
            GitHubRepository.user_id == user_id,
            GitHubRepository.github_repository_id == github_repository_id,
            GitHubInstallation.user_id == user_id,
        )
        .limit(1)
    )
    return result.one_or_none()


async def select_owned_repository(
    database: AsyncSession,
    *,
    user_id: UUID,
    github_repository_id: int,
) -> GitHubRepository | None:
    locked_user = await _locked_user(database, user_id)
    if locked_user is None or locked_user.github_user_id is None:
        await database.rollback()
        return None
    owned = await get_owned_repository(
        database,
        user_id=user_id,
        github_repository_id=github_repository_id,
    )
    if owned is None:
        await database.rollback()
        return None
    repository, _installation = owned
    await database.execute(
        update(GitHubRepository)
        .where(GitHubRepository.user_id == user_id, GitHubRepository.is_selected.is_(True))
        .values(is_selected=False, updated_at=utcnow())
    )
    repository.is_selected = True
    repository.updated_at = utcnow()
    await database.execute(delete(MissionVerification).where(MissionVerification.user_id == user_id))
    await database.commit()
    return repository


async def selected_owned_repository(
    database: AsyncSession,
    *,
    user_id: UUID,
) -> tuple[GitHubRepository, GitHubInstallation] | None:
    result = await database.execute(
        select(GitHubRepository, GitHubInstallation)
        .join(GitHubInstallation, GitHubRepository.installation_id == GitHubInstallation.id)
        .where(
            GitHubRepository.user_id == user_id,
            GitHubRepository.is_selected.is_(True),
            GitHubInstallation.user_id == user_id,
        )
        .limit(1)
    )
    return result.one_or_none()


async def upsert_verification(
    database: AsyncSession,
    *,
    user_id: UUID,
    mission_id: str,
    github_repository_id: int,
    result: VerificationResult,
) -> MissionVerification | None:
    locked_user = await _locked_user(database, user_id)
    if locked_user is None or locked_user.github_user_id is None:
        await database.rollback()
        return None
    still_selected = (
        await database.execute(
            select(GitHubRepository.id)
            .where(
                GitHubRepository.user_id == user_id,
                GitHubRepository.github_repository_id == github_repository_id,
                GitHubRepository.is_selected.is_(True),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if still_selected is None:
        await database.rollback()
        return None
    verification = (
        await database.execute(
            select(MissionVerification)
            .where(
                MissionVerification.user_id == user_id,
                MissionVerification.mission_id == mission_id,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    now = utcnow()
    if verification is None:
        verification = MissionVerification(
            user_id=user_id,
            mission_id=mission_id,
            github_repository_id=github_repository_id,
            status=result.status,
            evidence_json=list(result.evidence),
            reason=result.reason,
            checked_at=now,
        )
        database.add(verification)
    else:
        verification.github_repository_id = github_repository_id
        verification.status = result.status
        verification.evidence_json = list(result.evidence)
        verification.reason = result.reason
        verification.checked_at = now
        verification.updated_at = now
    await database.commit()
    return verification


async def disconnect_github(
    database: AsyncSession,
    *,
    user: User,
) -> None:
    locked_user = await _locked_user(database, user.id)
    if locked_user is None:
        await database.rollback()
        return
    await database.execute(
        delete(GitHubOAuthTransaction).where(GitHubOAuthTransaction.user_id == locked_user.id)
    )
    await database.execute(delete(MissionVerification).where(MissionVerification.user_id == locked_user.id))
    installation_ids = select(GitHubInstallation.id).where(GitHubInstallation.user_id == locked_user.id)
    await database.execute(
        delete(GitHubRepository).where(GitHubRepository.installation_id.in_(installation_ids))
    )
    await database.execute(delete(GitHubInstallation).where(GitHubInstallation.user_id == locked_user.id))
    locked_user.github_user_id = None
    locked_user.github_authorized_at = None
    locked_user.github_verification_started_at = None
    await database.commit()

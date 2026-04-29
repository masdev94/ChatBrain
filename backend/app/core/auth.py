"""Authentication dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import jwt
import structlog
from fastapi import Depends, Header, HTTPException, status
from jwt import PyJWKClient
from supabase import Client

from .config import settings
from .supabase import user_client

logger = structlog.get_logger(__name__)

_SUPPORTED_ASYMMETRIC = {"ES256", "RS256", "ES384", "RS384", "ES512", "RS512"}


@dataclass(frozen=True)
class AuthUser:
    id: str
    email: str | None
    access_token: str


def _extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization.split(" ", 1)[1].strip()


@lru_cache(maxsize=1)
def _jwks_client() -> PyJWKClient:
    """Cached JWKS fetcher. PyJWKClient caches individual signing keys in-memory."""
    jwks_url = f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
    return PyJWKClient(jwks_url, cache_keys=True, lifespan=3600)


def _verify(token: str) -> dict:
    """Verify `token`'s signature + claims and return the payload."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Malformed token") from exc

    alg = (header.get("alg") or "").upper()
    # We deliberately do NOT validate ``iat`` against the wall clock.
    # ``iat`` is informational ("when this token was issued") rather
    # than a security primitive — the real "don't use before" claim
    # would be ``nbf``, which Supabase doesn't emit. Validating it is
    # a footgun on dev hosts whose clock drifts (Windows dev boxes
    # commonly skew 30+ seconds), causing spurious 401s right after
    # sign-in even though the token is otherwise perfectly valid.
    # ``exp`` is still enforced strictly, so token lifetime is bounded.
    # A small leeway covers any residual ``exp`` rounding skew.
    decode_opts = {
        "audience": "authenticated",
        "leeway": 30,
        "options": {
            "require": ["sub", "exp"],
            "verify_iat": False,
        },
    }

    try:
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise HTTPException(
                    status_code=401,
                    detail=(
                        "Token is HS256 but SUPABASE_JWT_SECRET is not set. "
                        "Copy the value from Supabase Dashboard → Project Settings "
                        "→ API → JWT Keys → Legacy JWT Secret into backend/.env."
                    ),
                )
            return jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                **decode_opts,
            )

        if alg in _SUPPORTED_ASYMMETRIC:
            signing_key = _jwks_client().get_signing_key_from_jwt(token)
            return jwt.decode(
                token,
                signing_key.key,
                algorithms=[alg],
                **decode_opts,
            )

        raise HTTPException(
            status_code=401,
            detail=f"Unsupported token algorithm: {alg or 'unknown'}",
        )

    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Token expired") from exc
    except jwt.InvalidTokenError as exc:
        logger.warning("jwt.verify_failed", alg=alg, error=str(exc))
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}") from exc
    except HTTPException:
        raise
    except Exception as exc:  # network failure fetching JWKS, etc.
        logger.warning("jwt.verify_error", alg=alg, error=str(exc))
        raise HTTPException(status_code=401, detail=f"Could not verify token: {exc}") from exc


async def current_user(authorization: str | None = Header(default=None)) -> AuthUser:
    """Verify the caller's Supabase JWT and return the resolved user."""
    token = _extract_bearer(authorization)
    payload = _verify(token)

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing subject")

    return AuthUser(
        id=user_id,
        email=payload.get("email"),
        access_token=token,
    )


def user_db(user: AuthUser = Depends(current_user)) -> Client:
    """Supabase client pre-authenticated as the caller so RLS applies."""
    return user_client(user.access_token)

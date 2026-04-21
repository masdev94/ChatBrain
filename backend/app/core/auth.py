"""Authentication dependency.

Supabase issues HS256 JWTs signed with the project's JWT secret. We verify
them locally (no network call) and expose the resolved `AuthUser` + a
user-scoped Supabase client to every protected route.
"""

from __future__ import annotations

from dataclasses import dataclass

import jwt
from fastapi import Depends, Header, HTTPException, status
from supabase import Client

from .config import settings
from .supabase import user_client


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


async def current_user(authorization: str | None = Header(default=None)) -> AuthUser:
    """Verify the caller's Supabase JWT and return the resolved user."""
    token = _extract_bearer(authorization)
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
            options={"require": ["sub", "exp"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing subject")

    return AuthUser(id=user_id, email=payload.get("email"), access_token=token)


def user_db(user: AuthUser = Depends(current_user)) -> Client:
    """Supabase client pre-authenticated as the caller so RLS applies."""
    return user_client(user.access_token)

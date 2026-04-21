"""Supabase client factories.

Two flavours are used in the backend:

* The **service-role client** (`admin_client`) bypasses RLS and is used for
  background ingestion work where we already know the owning user_id.
* The **user-scoped client** (`user_client`) is built from the caller's JWT
  so that PostgREST enforces RLS on every query. Preferred for user-facing
  CRUD on sources, conversations and messages.
"""

from __future__ import annotations

from functools import lru_cache

from supabase import Client, create_client

from .config import settings


@lru_cache(maxsize=1)
def admin_client() -> Client:
    """Shared service-role client. Safe to reuse across requests."""
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def user_client(access_token: str) -> Client:
    """Per-request client that carries the user's JWT so RLS applies.

    We intentionally do **not** cache this: each authenticated request owns its
    own client instance bound to that user's token.
    """
    client = create_client(settings.supabase_url, settings.supabase_anon_key)
    client.postgrest.auth(access_token)
    # Also forward the token to Storage / Functions in case we need them later.
    client.options.headers["Authorization"] = f"Bearer {access_token}"
    return client

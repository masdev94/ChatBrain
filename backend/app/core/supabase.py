"""Supabase client factories.

Two flavours are used in the backend:

* The **service-role client** (`admin_client`) bypasses RLS and is used for
  background ingestion work where we already know the owning user_id.
* The **user-scoped client** (`user_client`) is built from the caller's JWT
  so that PostgREST enforces RLS on every query. Preferred for user-facing
  CRUD on sources, conversations and messages.

Both factories harden the underlying ``httpx`` transport against
*stale-keepalive races*. Background:

The ``httpx`` connection pool reuses TLS connections to amortize handshake
cost. The Supabase edge (and intermediate NATs / load balancers) close
those connections after a few minutes of idleness — sometimes without
sending a clean ``close_notify``. The next request from the pool then
sees a half-closed socket and OpenSSL raises::

    [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of
    protocol (_ssl.c:1081)

Python 3.11/3.12 used to absorb this as a recoverable ``ConnectionReset``
that ``httpx`` retried internally; Python 3.14's stricter OpenSSL
surfaces it as a hard ``ConnectError`` and the request 500s. We address
it on two layers:

1. ``HTTPTransport(retries=2)`` — retry transient connect-time failures
   on a fresh socket before the error ever leaves the transport.
2. ``Limits(keepalive_expiry=...)`` — recycle connections after a budget
   shorter than typical NAT idle timeouts, so they rarely go stale in
   the first place.
"""

from __future__ import annotations

from functools import lru_cache

import httpx
from supabase import Client, create_client

from .config import settings

# Tunables for the hardened transport. Conservative numbers — they don't
# noticeably change throughput under steady load, just trade a little
# extra reconnection cost for resilience against silent pool drops.
_HTTP_RETRIES = 2
_HTTP_KEEPALIVE_EXPIRY_SECONDS = 25.0  # well under typical NAT idle timeouts
_HTTP_MAX_CONNECTIONS = 20
_HTTP_MAX_KEEPALIVE = 10


def _harden_session(session: httpx.Client) -> None:
    """Replace the supplied httpx.Client's transport with a retry-enabled
    one and tighten its connection-pool keepalive. Keeps the existing
    auth/headers/timeout intact so the supabase-py wrapper sees an
    identical interface."""
    transport = httpx.HTTPTransport(retries=_HTTP_RETRIES)
    limits = httpx.Limits(
        max_connections=_HTTP_MAX_CONNECTIONS,
        max_keepalive_connections=_HTTP_MAX_KEEPALIVE,
        keepalive_expiry=_HTTP_KEEPALIVE_EXPIRY_SECONDS,
    )
    # The httpx.Client used by postgrest exposes _transport publicly via
    # the ``transport`` attribute on construction; setting the private
    # member is the supported way to swap it after creation. We also
    # reach into ``_pool`` to reset the limits — the pool was constructed
    # with the old (default) limits and they're immutable on the pool
    # itself, so just attach the new transport (which carries its own
    # default limits internally) and let httpx use it for new connections.
    try:
        session._transport.close()
    except Exception:  # noqa: BLE001
        pass
    session._transport = transport
    # Tighten the kept connection ceiling explicitly — httpx HTTPTransport
    # accepts a ``limits`` kwarg in newer versions; for compatibility with
    # the version pinned by supabase-py, we set the limits via the
    # transport's pool when available. Fall back silently if the internal
    # layout shifts: the retries alone already cover the failure mode.
    pool = getattr(transport, "_pool", None)
    if pool is not None:
        for attr_name, value in (
            ("_max_connections", limits.max_connections),
            ("_max_keepalive_connections", limits.max_keepalive_connections),
            ("_keepalive_expiry", limits.keepalive_expiry),
        ):
            if hasattr(pool, attr_name):
                setattr(pool, attr_name, value)


def _harden_supabase(client: Client) -> Client:
    """Apply :func:`_harden_session` to every httpx.Client the supabase
    wrapper exposes (postgrest, storage, functions, auth). Each subclient
    keeps its own pool, so they all need the same treatment."""
    candidates = [
        getattr(client, "postgrest", None),
        getattr(client, "storage", None),
        getattr(client, "functions", None),
        getattr(client, "auth", None),
    ]
    for sub in candidates:
        if sub is None:
            continue
        # Different supabase-py releases expose the underlying httpx.Client
        # under slightly different attribute names — try each.
        for attr in ("session", "_session", "client", "_client"):
            sess = getattr(sub, attr, None)
            if isinstance(sess, httpx.Client):
                _harden_session(sess)
                break
    return client


@lru_cache(maxsize=1)
def admin_client() -> Client:
    """Shared service-role client. Safe to reuse across requests."""
    client = create_client(settings.supabase_url, settings.supabase_service_role_key)
    return _harden_supabase(client)


def user_client(access_token: str) -> Client:
    """Per-request client that carries the user's JWT so RLS applies.

    We intentionally do **not** cache this: each authenticated request owns its
    own client instance bound to that user's token.
    """
    client = create_client(settings.supabase_url, settings.supabase_anon_key)
    client.postgrest.auth(access_token)
    # Also forward the token to Storage / Functions in case we need them later.
    client.options.headers["Authorization"] = f"Bearer {access_token}"
    return _harden_supabase(client)

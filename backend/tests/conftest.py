"""Test harness.

We inject harmless env defaults so `app.core.config.Settings` can be
instantiated inside tests without a real .env file on disk.
"""

from __future__ import annotations

import os

_DEFAULTS = {
    "SUPABASE_URL": "https://test.supabase.co",
    "SUPABASE_ANON_KEY": "test-anon",
    "SUPABASE_SERVICE_ROLE_KEY": "test-service",
    "SUPABASE_JWT_SECRET": "test-secret",
    "OPENAI_API_KEY": "test-openai",
}

for k, v in _DEFAULTS.items():
    os.environ.setdefault(k, v)

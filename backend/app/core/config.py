"""Runtime configuration loaded from the environment.

All values live in a single `Settings` object instantiated once at import time
so the rest of the app can import `settings` directly without re-parsing env.
"""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Supabase
    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str
    # HS256 JWT secret (legacy projects). Projects using asymmetric JWT
    # signing (ES256 / RS256) don't expose a shared secret — leave empty
    # and the backend will verify tokens via the project's JWKS endpoint.
    supabase_jwt_secret: str = ""

    # OpenAI
    openai_api_key: str
    openai_chat_model: str = "gpt-4o-mini"
    openai_embedding_model: str = "text-embedding-3-small"
    openai_vision_model: str = "gpt-4o-mini"

    # CORS
    allowed_origins: str = "http://localhost:3000"

    # URL scraping
    # When the static httpx + trafilatura path returns < MIN_CHARS we can fall
    # back to a real headless browser. Set to false in CI / minimal Docker
    # images that don't ship Chromium.
    playwright_enabled: bool = True
    # Per-page navigation budget for the headless fallback (seconds).
    playwright_navigation_timeout: float = Field(default=30.0, ge=5.0, le=120.0)
    # Buffer after networkidle before harvesting HTML (seconds). Catches
    # late-bound JS that paints content after initial load completes.
    playwright_settle_seconds: float = Field(default=1.5, ge=0.0, le=10.0)

    # Chunking
    chunk_target_tokens: int = Field(default=800, ge=100, le=4000)
    chunk_overlap_tokens: int = Field(default=150, ge=0, le=1000)

    # Retrieval
    # Legacy single-vector cap, retained for backwards compatibility / direct
    # callers. The chat orchestrator now uses the multi-query path below.
    retrieval_top_k: int = Field(default=8, ge=1, le=50)
    # When the question gets decomposed into N sub-queries we run match_chunks
    # once per sub-query asking for this many candidates each, then fuse with
    # Reciprocal Rank Fusion and trim to `retrieval_final_top_k`.
    retrieval_top_k_per_query: int = Field(default=6, ge=1, le=50)
    retrieval_final_top_k: int = Field(default=10, ge=1, le=50)
    # Diversity cap: no single source contributes more than this many chunks
    # to the final fused list. Prevents one chatty doc from drowning the rest.
    retrieval_max_per_source: int = Field(default=3, ge=1, le=50)

    # Long-term memory (per-conversation vector store of past turn summaries).
    # Used to give the decomposer + answerer continuity across turns so
    # compound follow-ups ("compare those two") can resolve their referents.
    memory_enabled: bool = True
    # How many memory fragments we surface per new turn.
    memory_top_k: int = Field(default=3, ge=1, le=10)
    # Below this similarity, a fragment is treated as too off-topic to be
    # worth biasing the prompt with. 0.6 is a conservative cosine threshold
    # for OpenAI text-embedding-3-small in our domain.
    memory_min_similarity: float = Field(default=0.6, ge=0.0, le=1.0)

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()

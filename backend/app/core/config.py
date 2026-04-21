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
    supabase_jwt_secret: str

    # OpenAI
    openai_api_key: str
    openai_chat_model: str = "gpt-4o-mini"
    openai_embedding_model: str = "text-embedding-3-small"
    openai_vision_model: str = "gpt-4o-mini"

    # CORS
    allowed_origins: str = "http://localhost:3000"

    # Chunking
    chunk_target_tokens: int = Field(default=800, ge=100, le=4000)
    chunk_overlap_tokens: int = Field(default=150, ge=0, le=1000)

    # Retrieval
    retrieval_top_k: int = Field(default=8, ge=1, le=50)

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()

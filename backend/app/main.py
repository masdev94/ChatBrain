"""FastAPI application entrypoint."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import chat as chat_api
from .api import conversations as conversations_api
from .api import sources as sources_api
from .core.config import settings
from .core.logging import configure_logging, logger


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    logger.info("chatbrain.start", origins=settings.allowed_origins_list)
    yield
    logger.info("chatbrain.stop")


app = FastAPI(title="ChatBrain API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok"}


app.include_router(sources_api.router)
app.include_router(conversations_api.router)
app.include_router(chat_api.router)

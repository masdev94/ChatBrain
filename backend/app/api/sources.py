"""Knowledge-base source endpoints.

All writes create a ``sources`` row in the ``pending`` state and then schedule
a FastAPI BackgroundTask that takes the source through
``processing → ready|failed``. The frontend polls (or subscribes via Supabase
Realtime) for status updates.
"""

from __future__ import annotations

import re
from typing import Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field, HttpUrl
from supabase import Client

from ..core.auth import AuthUser, current_user, user_db
from ..core.config import settings
from ..core.supabase import admin_client
from ..ingestion.pipeline import ingest_pdf, ingest_text, ingest_url

router = APIRouter(prefix="/sources", tags=["sources"])

MAX_TEXT_LENGTH = 1_000_000      # 1M chars ≈ 200k tokens
MAX_PDF_BYTES = 50 * 1024 * 1024


class SourceOut(BaseModel):
    id: str
    type: Literal["pdf", "text", "url"]
    title: str
    status: Literal["pending", "processing", "ready", "failed"]
    error: str | None = None
    url: str | None = None
    storage_path: str | None = None
    metadata: dict = Field(default_factory=dict)
    chunk_count: int = 0
    created_at: str
    updated_at: str


# ──────────────────────────────────────────────────────────────────────────
# List / delete
# ──────────────────────────────────────────────────────────────────────────
@router.get("", response_model=list[SourceOut])
async def list_sources(db: Client = Depends(user_db)):
    resp = (
        db.table("sources")
        .select("*")
        .order("created_at", desc=True)
        .execute()
    )
    return resp.data or []


@router.get("/{source_id}", response_model=SourceOut)
async def get_source(source_id: str, db: Client = Depends(user_db)):
    resp = db.table("sources").select("*").eq("id", source_id).single().execute()
    if not resp.data:
        raise HTTPException(status_code=404, detail="Source not found")
    return resp.data


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(source_id: str, db: Client = Depends(user_db)):
    # Fetch first so we know if there's a storage blob to remove.
    existing = db.table("sources").select("storage_path").eq("id", source_id).maybe_single().execute()
    if existing and existing.data:
        path = existing.data.get("storage_path")
        if path:
            # Best-effort: RLS limits the user to their own prefix anyway.
            try:
                db.storage.from_("sources").remove([path])
            except Exception:  # noqa: BLE001 - deletion is best-effort
                pass

    # Cascade deletes chunks via the FK.
    db.table("sources").delete().eq("id", source_id).execute()
    return None


# ──────────────────────────────────────────────────────────────────────────
# Create: text
# ──────────────────────────────────────────────────────────────────────────
class CreateTextSource(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH)


@router.post("/text", response_model=SourceOut, status_code=201)
async def create_text_source(
    body: CreateTextSource,
    background: BackgroundTasks,
    user: AuthUser = Depends(current_user),
    db: Client = Depends(user_db),
):
    resp = (
        db.table("sources")
        .insert(
            {
                "user_id": user.id,
                "type": "text",
                "title": body.title.strip(),
                "status": "pending",
            }
        )
        .execute()
    )
    row = resp.data[0]

    admin = admin_client()
    background.add_task(
        ingest_text,
        admin,
        source_id=row["id"],
        user_id=user.id,
        text=body.content,
        target_tokens=settings.chunk_target_tokens,
        overlap_tokens=settings.chunk_overlap_tokens,
    )
    return row


# ──────────────────────────────────────────────────────────────────────────
# Create: URL
# ──────────────────────────────────────────────────────────────────────────
class CreateUrlSource(BaseModel):
    url: HttpUrl
    title: str | None = Field(default=None, max_length=200)


@router.post("/url", response_model=SourceOut, status_code=201)
async def create_url_source(
    body: CreateUrlSource,
    background: BackgroundTasks,
    user: AuthUser = Depends(current_user),
    db: Client = Depends(user_db),
):
    fallback_title = body.title or str(body.url)
    resp = (
        db.table("sources")
        .insert(
            {
                "user_id": user.id,
                "type": "url",
                "title": fallback_title.strip(),
                "url": str(body.url),
                "status": "pending",
            }
        )
        .execute()
    )
    row = resp.data[0]

    admin = admin_client()
    background.add_task(
        ingest_url,
        admin,
        source_id=row["id"],
        user_id=user.id,
        url=str(body.url),
        target_tokens=settings.chunk_target_tokens,
        overlap_tokens=settings.chunk_overlap_tokens,
    )
    return row


# ──────────────────────────────────────────────────────────────────────────
# Create: PDF
# ──────────────────────────────────────────────────────────────────────────
@router.post("/pdf", response_model=SourceOut, status_code=201)
async def create_pdf_source(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    user: AuthUser = Depends(current_user),
    db: Client = Depends(user_db),
):
    if file.content_type not in {"application/pdf", "application/x-pdf"}:
        raise HTTPException(status_code=415, detail="Only PDF uploads are supported.")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF exceeds 50 MB limit.")

    chosen_title = (title or file.filename or "Untitled.pdf").strip()

    # Insert the row first so we have an id to use as the storage path.
    resp = (
        db.table("sources")
        .insert(
            {
                "user_id": user.id,
                "type": "pdf",
                "title": chosen_title,
                "status": "pending",
            }
        )
        .execute()
    )
    row = resp.data[0]
    source_id = row["id"]

    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", (file.filename or "upload.pdf"))
    storage_path = f"{user.id}/{source_id}/{safe_name}"

    admin = admin_client()
    try:
        admin.storage.from_("sources").upload(
            storage_path,
            data,
            {"content-type": "application/pdf", "upsert": "true"},
        )
    except Exception as exc:  # noqa: BLE001
        admin.table("sources").update(
            {"status": "failed", "error": f"Upload to storage failed: {exc}"}
        ).eq("id", source_id).execute()
        raise HTTPException(status_code=500, detail="Storage upload failed.") from exc

    admin.table("sources").update({"storage_path": storage_path}).eq("id", source_id).execute()

    background.add_task(
        ingest_pdf,
        admin,
        source_id=source_id,
        user_id=user.id,
        pdf_bytes=data,
        target_tokens=settings.chunk_target_tokens,
        overlap_tokens=settings.chunk_overlap_tokens,
    )

    row["storage_path"] = storage_path
    return row

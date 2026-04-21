"""Conversation + message CRUD."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from supabase import Client

from ..core.auth import AuthUser, current_user, user_db

router = APIRouter(prefix="/conversations", tags=["conversations"])


class ConversationOut(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class MessageOut(BaseModel):
    id: str
    conversation_id: str
    role: Literal["user", "assistant"]
    content: str
    reasoning: list | None = None
    citations: list | None = None
    created_at: str


class CreateConversation(BaseModel):
    title: str | None = Field(default=None, max_length=200)


class UpdateConversation(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.get("", response_model=list[ConversationOut])
async def list_conversations(db: Client = Depends(user_db)):
    resp = db.table("conversations").select("*").order("updated_at", desc=True).execute()
    return resp.data or []


@router.post("", response_model=ConversationOut, status_code=201)
async def create_conversation(
    body: CreateConversation,
    user: AuthUser = Depends(current_user),
    db: Client = Depends(user_db),
):
    payload = {"user_id": user.id}
    if body.title:
        payload["title"] = body.title.strip()
    resp = db.table("conversations").insert(payload).execute()
    return resp.data[0]


@router.patch("/{conversation_id}", response_model=ConversationOut)
async def rename_conversation(
    conversation_id: str,
    body: UpdateConversation,
    db: Client = Depends(user_db),
):
    resp = (
        db.table("conversations")
        .update({"title": body.title.strip()})
        .eq("id", conversation_id)
        .execute()
    )
    if not resp.data:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return resp.data[0]


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: str, db: Client = Depends(user_db)):
    db.table("conversations").delete().eq("id", conversation_id).execute()
    return None


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
async def list_messages(conversation_id: str, db: Client = Depends(user_db)):
    # Confirm ownership (RLS will also enforce, but we want a 404 vs empty list).
    conv = (
        db.table("conversations")
        .select("id")
        .eq("id", conversation_id)
        .maybe_single()
        .execute()
    )
    if not conv or not conv.data:
        raise HTTPException(status_code=404, detail="Conversation not found")

    resp = (
        db.table("messages")
        .select("*")
        .eq("conversation_id", conversation_id)
        .order("created_at", desc=False)
        .execute()
    )
    return resp.data or []

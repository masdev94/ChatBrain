"""Streaming RAG chat endpoint.

Clients POST ``{conversation_id, content}`` and receive a Server-Sent Events
stream. Each event is JSON with a ``type`` field; see ``app.rag.chat`` for
the event vocabulary.

The user message is persisted before streaming starts so a client crash
won't lose the question. The assistant message is persisted in a ``finally``
block so the reasoning + answer are saved even if the client disconnects
mid-stream.
"""

from __future__ import annotations

import json
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from supabase import Client

from ..core.auth import AuthUser, current_user, user_db
from ..core.supabase import admin_client
from ..rag.chat import ChatResult, Turn, stream_chat_turn

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    conversation_id: str
    content: str = Field(min_length=1, max_length=8000)


def _sse(event: dict) -> bytes:
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n".encode()


@router.post("/stream")
async def chat_stream(
    body: ChatRequest,
    user: AuthUser = Depends(current_user),
    db: Client = Depends(user_db),
):
    # Verify conversation ownership (RLS would 0-row otherwise).
    conv = (
        db.table("conversations")
        .select("id,title")
        .eq("id", body.conversation_id)
        .maybe_single()
        .execute()
    )
    if not conv or not conv.data:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Load prior turns to drive the rewrite step and history-aware answering.
    prior_resp = (
        db.table("messages")
        .select("role,content")
        .eq("conversation_id", body.conversation_id)
        .order("created_at", desc=False)
        .execute()
    )
    history = [Turn(role=r["role"], content=r["content"]) for r in prior_resp.data or []]

    # Persist the user's turn immediately.
    user_msg = (
        db.table("messages")
        .insert(
            {
                "conversation_id": body.conversation_id,
                "user_id": user.id,
                "role": "user",
                "content": body.content,
            }
        )
        .execute()
    )
    if not user_msg.data:
        raise HTTPException(status_code=500, detail="Could not record user message")

    # Auto-title the conversation from its first user message.
    if len(history) == 0:
        auto_title = body.content.strip().splitlines()[0][:80]
        db.table("conversations").update({"title": auto_title or "New conversation"}).eq(
            "id", body.conversation_id
        ).execute()

    admin = admin_client()
    result = ChatResult()

    async def event_stream() -> AsyncIterator[bytes]:
        try:
            async for event in stream_chat_turn(
                admin,
                user_id=user.id,
                history=history,
                question=body.content,
                result=result,
            ):
                yield _sse(event)
        finally:
            # Save whatever we have, even on disconnect. This persists the
            # reasoning trail plus the (possibly partial) answer so refreshes
            # mirror the user's live view.
            if result.answer:
                admin.table("messages").insert(
                    {
                        "conversation_id": body.conversation_id,
                        "user_id": user.id,
                        "role": "assistant",
                        "content": result.answer,
                        "reasoning": result.reasoning,
                        "citations": result.citations,
                    }
                ).execute()
                admin.table("conversations").update({}).eq(
                    "id", body.conversation_id
                ).execute()  # touches updated_at via trigger

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )

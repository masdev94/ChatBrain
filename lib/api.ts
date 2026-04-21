// Thin wrapper around the FastAPI backend. Every call forwards the user's
// Supabase access token as a Bearer so the backend's JWT verifier can
// resolve the caller and enforce RLS.

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function authHeader(): Promise<Record<string, string>> {
  const supabase = getSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await authHeader()),
  };
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err?.detail) detail = String(err.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Types mirror the backend Pydantic models.
// ──────────────────────────────────────────────────────────────────────────
export type SourceType = "pdf" | "text" | "url";
export type SourceStatus = "pending" | "processing" | "ready" | "failed";

export interface SourceRow {
  id: string;
  type: SourceType;
  title: string;
  status: SourceStatus;
  error: string | null;
  url: string | null;
  storage_path: string | null;
  metadata: Record<string, unknown>;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Citation {
  source_id: string;
  title: string;
  type: SourceType;
  url: string | null;
  snippet: string;
  tag: string;
}

export interface ReasoningEvent {
  type: "thinking" | "sources_considered";
  text?: string;
  sources?: Array<{
    source_id: string;
    title: string;
    type: SourceType;
    url: string | null;
    chunk_count: number;
    top_similarity: number;
  }>;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: ReasoningEvent[] | null;
  citations: Citation[] | null;
  created_at: string;
}

// ──────────────────────────────────────────────────────────────────────────
// API surface
// ──────────────────────────────────────────────────────────────────────────
export const api = {
  sources: {
    list: () => jsonRequest<SourceRow[]>("GET", "/sources"),
    createText: (title: string, content: string) =>
      jsonRequest<SourceRow>("POST", "/sources/text", { title, content }),
    createUrl: (url: string, title?: string) =>
      jsonRequest<SourceRow>("POST", "/sources/url", { url, title: title || undefined }),
    createPdf: async (file: File, title?: string) => {
      const form = new FormData();
      form.append("file", file);
      if (title) form.append("title", title);
      const res = await fetch(`${API_URL}/sources/pdf`, {
        method: "POST",
        headers: await authHeader(),
        body: form,
      });
      if (!res.ok) {
        let detail = `${res.status}`;
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {
          /* ignore */
        }
        throw new ApiError(detail, res.status);
      }
      return (await res.json()) as SourceRow;
    },
    remove: (id: string) => jsonRequest<void>("DELETE", `/sources/${id}`),
  },
  conversations: {
    list: () => jsonRequest<Conversation[]>("GET", "/conversations"),
    create: (title?: string) =>
      jsonRequest<Conversation>("POST", "/conversations", { title }),
    rename: (id: string, title: string) =>
      jsonRequest<Conversation>("PATCH", `/conversations/${id}`, { title }),
    remove: (id: string) => jsonRequest<void>("DELETE", `/conversations/${id}`),
    messages: (id: string) =>
      jsonRequest<Message[]>("GET", `/conversations/${id}/messages`),
  },
  chat: {
    /**
     * Streams a chat turn as typed JSON events. Returns an async iterator so
     * callers can render reasoning / tokens as they arrive.
     */
    stream: async function* (
      conversationId: string,
      content: string,
      signal?: AbortSignal,
    ): AsyncGenerator<Record<string, unknown>, void, unknown> {
      const res = await fetch(`${API_URL}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeader()),
        },
        body: JSON.stringify({ conversation_id: conversationId, content }),
        signal,
      });

      if (!res.ok || !res.body) {
        let detail = `${res.status}`;
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {
          /* ignore */
        }
        throw new ApiError(detail, res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                yield JSON.parse(payload);
              } catch {
                /* ignore malformed frame */
              }
            }
          }
        }
      }
    },
  },
};

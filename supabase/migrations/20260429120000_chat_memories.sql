-- Long-term memory for the chat orchestrator.
--
-- After each completed assistant turn the backend writes a compact,
-- embedded "memory fragment" describing what was discussed (the user's
-- intent, the assistant's gist, and which sources were referenced).
-- New turns retrieve the most relevant fragments for the active
-- conversation and feed them to the decomposer + answer LLM, so
-- multi-part follow-ups have continuity and cross-source synthesis
-- doesn't restart from scratch every turn.
--
-- Why a separate table (vs reusing messages):
--   * messages stores raw user/assistant text. Embedding the full
--     answer would mix verbose prose with the actual semantic signal
--     (the question's *topic* + the answer's *gist*) and hurt recall.
--   * memories are short (<= ~280 chars), tightly scoped, and carry
--     a separate "importance" knob + the citation provenance, which
--     keeps them cheap to filter, prune, and inspect.
--   * scoping by conversation_id lets us keep this strictly per-thread
--     for now (no cross-conversation leakage); broadening later is a
--     non-breaking change.

create table if not exists public.chat_memories (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- The 0-based turn index this memory was created from. Used for
  -- ordering, deduplication, and cheap "show me the last N turns"
  -- queries without a vector lookup.
  turn_index      integer not null,
  summary         text not null,
  embedding       vector(1536),
  -- Free-form 0..1 importance for future memory-decay / consolidation
  -- work. Defaulted to 0.5 today; the writer can override per-turn.
  importance      real not null default 0.5,
  -- Source ids cited in the originating turn. Acts as a soft
  -- "source-prior": when this memory matches a new query, the
  -- retriever knows these sources were previously useful for the
  -- thread and can bias top-k toward them.
  source_ids      uuid[] not null default '{}'::uuid[],
  created_at      timestamptz not null default now()
);

create index if not exists chat_memories_conversation_idx
  on public.chat_memories (conversation_id, turn_index);

create index if not exists chat_memories_user_idx
  on public.chat_memories (user_id);

-- HNSW gives good recall/latency on small per-conversation memory
-- tables and matches the chunks index choice for consistency.
create index if not exists chat_memories_embedding_hnsw_idx
  on public.chat_memories using hnsw (embedding vector_cosine_ops);

-- ────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- Each authenticated user can only read/write rows they own. The service
-- role (used by the FastAPI backend) bypasses RLS automatically.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.chat_memories enable row level security;

drop policy if exists "chat_memories_owner_all" on public.chat_memories;

create policy "chat_memories_owner_all"
  on public.chat_memories for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Conversation-scoped similarity search RPC
-- The backend calls this with both owner_id and conversation_id so the
-- service-role client (which bypasses RLS) still gets per-conversation
-- isolation. Mirrors the shape of public.match_chunks.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.match_memories(
  query_embedding vector(1536),
  conversation    uuid,
  match_count     integer,
  owner_id        uuid
)
returns table (
  id              uuid,
  conversation_id uuid,
  turn_index      integer,
  summary         text,
  importance      real,
  source_ids      uuid[],
  similarity      float
)
language sql
stable
as $$
  select
    m.id,
    m.conversation_id,
    m.turn_index,
    m.summary,
    m.importance,
    m.source_ids,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.chat_memories m
  where m.user_id = owner_id
    and m.conversation_id = conversation
    and m.embedding is not null
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

revoke all on function public.match_memories(vector, uuid, integer, uuid) from public;
grant execute on function public.match_memories(vector, uuid, integer, uuid)
  to authenticated, service_role;

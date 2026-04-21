-- ChatBrain initial schema
-- Creates sources (knowledge base items), chunks (embedded text), conversations, messages
-- plus Row-Level Security so each user only ever touches their own rows, and a
-- match_chunks RPC used by the backend to perform cosine similarity search.

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ────────────────────────────────────────────────────────────────────────────
-- Enums
-- ────────────────────────────────────────────────────────────────────────────
do $$ begin
  create type public.source_type as enum ('pdf', 'text', 'url');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.source_status as enum ('pending', 'processing', 'ready', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.message_role as enum ('user', 'assistant');
exception when duplicate_object then null; end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Tables
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.sources (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  type          public.source_type not null,
  title         text not null,
  status        public.source_status not null default 'pending',
  error         text,
  storage_path  text,                                   -- populated for PDFs in the `sources` bucket
  url           text,                                   -- populated for URL sources
  metadata      jsonb not null default '{}'::jsonb,     -- e.g. {page_count, char_count, domain, extracted_via}
  chunk_count   integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists sources_user_created_idx
  on public.sources (user_id, created_at desc);

create table if not exists public.chunks (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid not null references public.sources(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  chunk_index  integer not null,
  content      text not null,
  token_count  integer not null,
  embedding    vector(1536),
  created_at   timestamptz not null default now()
);

create index if not exists chunks_source_idx
  on public.chunks (source_id, chunk_index);

create index if not exists chunks_user_idx
  on public.chunks (user_id);

-- HNSW gives good recall/latency for small and large corpora and, unlike
-- ivfflat, does not require an initial training step on existing vectors.
create index if not exists chunks_embedding_hnsw_idx
  on public.chunks using hnsw (embedding vector_cosine_ops);

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'New conversation',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             public.message_role not null,
  content          text not null,
  reasoning        jsonb,   -- array of thinking events captured during generation
  citations        jsonb,   -- array of {source_id, title, chunk_index, snippet}
  created_at       timestamptz not null default now()
);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);

-- ────────────────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sources_touch_updated on public.sources;
create trigger sources_touch_updated
  before update on public.sources
  for each row execute function public.touch_updated_at();

drop trigger if exists conversations_touch_updated on public.conversations;
create trigger conversations_touch_updated
  before update on public.conversations
  for each row execute function public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- Each authenticated user can only read/write rows they own.
-- The service role (used by the FastAPI backend) bypasses RLS automatically.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.sources       enable row level security;
alter table public.chunks        enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

drop policy if exists "sources_owner_all"       on public.sources;
drop policy if exists "chunks_owner_all"        on public.chunks;
drop policy if exists "conversations_owner_all" on public.conversations;
drop policy if exists "messages_owner_all"      on public.messages;

create policy "sources_owner_all"
  on public.sources for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "chunks_owner_all"
  on public.chunks for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "conversations_owner_all"
  on public.conversations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "messages_owner_all"
  on public.messages for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Similarity-search RPC
-- Backend calls this with an owner_id to keep results scoped even when using
-- the service role key (which bypasses RLS).
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.match_chunks(
  query_embedding vector(1536),
  match_count     integer,
  owner_id        uuid
)
returns table (
  id           uuid,
  source_id    uuid,
  chunk_index  integer,
  content      text,
  similarity   float
)
language sql
stable
as $$
  select
    c.id,
    c.source_id,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.chunks c
  where c.user_id = owner_id
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Only authenticated users or the service role should call this.
revoke all on function public.match_chunks(vector, integer, uuid) from public;
grant execute on function public.match_chunks(vector, integer, uuid) to authenticated, service_role;

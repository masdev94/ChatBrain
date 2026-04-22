# ChatBrain — Demo & Implementation Notes

A companion to [README.md](./README.md). The README explains *what* ChatBrain
is and how to run it. This doc is the **five-minute demo script** plus a
concrete tour of the engineering decisions that make the app production-shaped
rather than hackathon-shaped.

---

## 1. Five-minute demo script

Open the app at `http://localhost:3000` after the setup steps in the README.

### 1.1 Auth (≈ 30s)

1. Land on **/sign-in**. Notice the two-column editorial layout (display
   heading, quiet feature list, orb + dot-grid background). On mobile the
   left column collapses; the form stays centred.
2. Click **Create an account** → enter any email and an 8-char password.
3. If the Supabase project has "Confirm email" off, you're dropped straight
   into `/app/sources`. Otherwise you'll see a *"Check your inbox"* banner on
   sign-in — click the link, return, sign in.

What to notice
- **Server Actions** (no API route, no client-side fetch) handle sign-in /
  sign-up / sign-out. Errors render inline via `useActionState`.
- If DNS to Supabase fails mid-sign-in, you get a human-readable message
  (*"Can't reach Supabase … check your network or DNS"*) instead of Next's
  generic "unexpected response". See `app/auth/actions.ts` →
  `friendlyNetworkMessage`.

### 1.2 Build the knowledge base (≈ 2 min)

On `/app/sources`:

1. **Paste text** — tab is selected by default. Paste any SOP or note, give
   it a title, press *Add text source*. The row appears instantly as
   `queued`, then flips `processing` → `ready` within a few seconds.
2. **Upload PDF** — drop any PDF up to 50 MB. Try a scanned one — the
   backend OCR-fallbacks through OpenAI Vision when the page text layer is
   empty or junk.
3. **Add URL** — paste any public article URL. Titles are auto-extracted.
4. While ingestion runs, the **"Sources (X of Y ready)"** counter updates
   live (polling every 2s only while anything is pending).

What to notice
- Status pills use semantic colors + pulsing dots. Failed sources surface
  their actual error message below the row.
- PDF upload is a single `multipart/form-data` request — the file goes
  straight from the browser to the FastAPI backend, which streams it to
  Supabase Storage under `{user_id}/{source_id}/file.pdf`. Nothing hits
  Next.js' Node runtime.
- Everything is scoped per user. Open a second Supabase user account in a
  private window — their sources list is empty; RLS is doing the work,
  not application-level filtering.

### 1.3 First chat (≈ 90 s)

1. Click **New chat** in the sidebar.
2. Ask *"What's our return policy for damaged items?"*.
3. Watch the answer compose in four visible phases:

   | Phase | UI surface |
   |---|---|
   | Understanding the question | Streamed thinking line |
   | Rewriting pronouns into a standalone query | Thinking line |
   | Searching embeddings | Thinking line + Sources-considered chips |
   | Reading k passages and writing | Answer tokens stream with `[Sn]` pills |

4. Follow up with *"And how long does the customer have?"*. The rewrite
   stage converts the pronoun to *"How long does a customer have to return
   a damaged item?"* — you can read that decision live in the thinking
   panel.
5. Ask something **off-topic** like *"What's the weather in Paris?"*. The
   grounding contract in `ANSWER_SYSTEM` forces an honest decline instead
   of a hallucinated answer.

What to notice
- **Thinking is a typed SSE stream**, not a spinner. Events include
  `thinking`, `sources_considered`, `token`, `citations`, `done`, `error`.
  See `backend/app/rag/chat.py` + `lib/api.ts → api.chat.stream`.
- `[Sn]` in the streamed text becomes a small accent pill inline (even
  inside `**bold**` and bulleted lists — we walk the markdown tree to
  substitute at text leaves).
- A **citation bar** under the answer links each tag to the original URL
  (for URL sources) with a tooltip showing the cited snippet.
- The composer has a focus glow; **Enter** sends, **Shift+Enter** newlines
  (keybinding hints live under the textarea).
- The chat area **scrolls internally** — the composer is pinned. No page
  scroll, ChatGPT-style.

### 1.4 Durability check (≈ 20 s)

1. Refresh the browser mid-conversation — thinking trail and citations
   are still rendered from the persisted `messages.reasoning`/`citations`
   JSON.
2. Click **Sign out** in the sidebar footer (avatar card, icon + full
   button), sign back in — the conversation and sources are exactly where
   you left them.

---

## 2. Engineering highlights — best practices, concrete

### 2.1 Security & auth

| Concern | How it's handled |
|---|---|
| **JWT verification** | Backend supports both HS256 (shared secret, legacy projects) **and** ES256 / RS256 (JWKS) — see `backend/app/core/auth.py`. JWKS keys are cached via `PyJWKClient`. |
| **Token scope** | `user_db()` issues a Supabase client with the user's own JWT so every DB read/write is evaluated under **RLS**. `admin_db()` is reserved for background ingestion, which always passes `owner_id` explicitly. |
| **Row-Level Security** | Every public table has `FOR ALL USING (auth.uid() = user_id)`. The `match_chunks` RPC takes `owner_id` as an argument and is only grantable to `authenticated` / `service_role`. |
| **Storage isolation** | Bucket policy matches `auth.uid()::text = (storage.foldername(name))[1]` — a user literally cannot list or read other users' folders. |
| **CSRF / cookie posture** | Sign-in uses Supabase-managed HttpOnly cookies via `@supabase/ssr`. Server Actions carry the Next.js CSRF token automatically. |
| **Secret hygiene** | `service_role` key is backend-only (`.env`, never imported on the client). Frontend only ever sees the `anon` key. |
| **Redirect-error safety** | Server actions wrap every Supabase call in a try/catch that re-throws the internal `NEXT_REDIRECT` sentinel so `redirect()` still works. Everything else is mapped to a friendly message. |

### 2.2 Retrieval-augmented generation

- **Chunker** (`backend/app/ingestion/chunker.py`) — token-aware,
  boundary-preserving, two-pass (atomize → pack). Default 800/150 target/overlap.
- **Embeddings** — `text-embedding-3-small`, 1536-dim, batched (up to 100
  inputs per request), stored in a `pgvector` column with an **HNSW**
  cosine index.
- **Retrieval** — a single SQL function `match_chunks(owner, query_vec, k)`
  does cosine similarity inside the DB, filtered by owner. No vector data
  crosses the wire.
- **Four-stage orchestrator** — `rewrite` (if history) → `retrieve` → `read`
  → `answer`. Each stage emits structured SSE events; the orchestrator is
  cleanly testable in isolation.
- **Grounding contract** — `ANSWER_SYSTEM` prompt hard-codes:
  *"Use only the provided `[S1]…[Sn]` excerpts; cite every factual claim;
  say so if the answer isn't in context."*
- **Citation grammar** — the model outputs `[S1]` inline; the frontend
  turns those into pills anywhere they appear (paragraphs, lists, tables,
  even inside `**bold**` or `*italic*`).
- **Persisted trace** — reasoning and citations are saved on the message
  row in a `finally` block so a refresh reproduces what the user saw live.

### 2.3 Ingestion best practices

- **PDF** — PyMuPDF text layer first; falls back to **OpenAI Vision OCR** per
  page when the text layer is missing or junk (tracked as `ocr_pages`).
  Pages are prefixed `[Page N]` so citations retain provenance.
- **URL** — `httpx` with explicit UA + 20 s timeout → `trafilatura` for
  main-article extraction. All four classic failure modes (`403`, `401`,
  `404`, non-HTML, timeout, DNS, empty extraction) map to user-facing
  copy surfaced on the source row.
- **Background work** — every ingestion pipeline runs as a FastAPI
  `BackgroundTask` so the HTTP request returns immediately with a `queued`
  status. Errors flip the row to `failed` with the message — the UI polls
  every 2 s and stops polling once everything's terminal.
- **Idempotence** — chunks are written in a single transaction; a failed
  pipeline leaves no half-ingested rows.

### 2.4 Frontend architecture (Next.js 16, React 19.2)

- **`proxy.ts`** (the Next 16 replacement for `middleware.ts`) runs on every
  protected route to refresh the Supabase session cookie and redirect
  unauthenticated requests.
- **Async request APIs** — `searchParams` and `params` are awaited
  (`PageProps<"/sign-in">` typing), matching the Next 16 breaking change.
- **Server Components by default** — every page in `/app/app/**` is a
  Server Component; client boundaries (`"use client"`) only where we need
  state or streams: `app-shell.tsx`, `sources-view.tsx`, `chat-view.tsx`,
  the two auth forms.
- **Server Actions** — sign-in / sign-up / sign-out live in
  `app/auth/actions.ts`. Forms use `useActionState` + `useFormStatus` for
  pending states without manual loading flags.
- **Stream reader** — `lib/api.ts → api.chat.stream` reads the SSE byte
  stream, parses typed events, and yields them as an async iterable — the
  chat view consumes it with a plain `for await … of` loop.
- **React 19-strict patterns** — no `setState` in effects for prop-driven
  state (we use the official *"store previous prop in state"* pattern),
  no `useRef` reads during render. The codebase lints clean.

### 2.5 Visual design system

The app is built to the standards in `CLAUDE.md` (frontend aesthetics).
Highlights:

- **Single unified design system** in `app/globals.css`:
  - Spacing, radius, shadow, duration, easing tokens as CSS custom props.
  - Cool-tech palette with one restrained **amber spark** used *only* to
    signal live streaming (caret, avatar dot, spinner).
  - Utilities: `.fade-up` + delay steps, `.noise-bg`, `.orb` / `.orb--amber`,
    `.dot-grid`, `.surface-elevated`, `.skeleton`.
- **Typography** — Geist Sans + Geist Mono (sanctioned developer/technical
  pairing, 2 families), display headings with `clamp()` scale and tight
  `letter-spacing: -0.035em`.
- **Motion** — staggered `fade-up` on page load, calm 120–220ms transitions
  on interaction, `prefers-reduced-motion` honored globally.
- **No anti-patterns** — no `transition: all`, no `!important`, no inline
  hex colors for reusable patterns, no `any` in TypeScript.
- **Accessibility** — semantic landmarks (`<nav>`, `<aside>`, `<main>`,
  `<header>`), `aria-current`, `aria-expanded`, `aria-selected`,
  `role="alert"/"status"`, consistent `:focus-visible` ring via
  `--shadow-focus`, `<kbd>` for keybinding hints.

### 2.6 UX details worth looking at

- **Layout containment** — shell is `h-dvh overflow-hidden` so every
  scrollable region is internal (messages, sources list, sidebar nav).
  The composer is pinned; the mobile drawer uses a backdrop with blur.
- **Status pills** — semantic colors + pulsing dot for live states.
- **Suggested prompts** on empty chat — three click-to-prefill pills that
  replace the blank canvas.
- **Inline kbd hints** under the composer (`Enter` / `Shift+Enter`).
- **Skeleton loaders** instead of spinners for the sidebar and source list.
- **Hover affordances** — destructive actions (delete source, sign out
  button) turn red on hover; primary actions lift subtly via shadow.

### 2.7 Observability

- `structlog` JSON logs on the backend with per-request fields (`user_id`,
  `source_id`, `chunk_count`, `latency_ms`).
- The chat stream logs `stage_start` / `stage_end` events so retrieval
  quality can be debugged from logs alone.
- Ingestion failure modes are recorded on the row itself — a support
  person can diagnose most issues without logs.

### 2.8 Testing strategy

`backend/tests` focuses on the invariants that matter, not coverage theatre:

- `test_chunker.py` — budget, overlap, contiguous indices, pathological
  inputs (empty, 1-char, giant paragraph, weird whitespace).
- `test_url.py` — each of the documented failure cases with `respx`
  fixtures returning real HTTP status/content-type combinations.
- `test_pdf.py` — text-layer happy path, `document closed` regression,
  OCR fallback triggered by empty page text.
- `test_chat.py` — citation post-processing (dangling `[S9]` tags
  removed, valid tags kept), rewrite stage on a conversation with
  pronouns, off-context question → honest refusal.

Mocks go through `respx` and in-process fakes — no network in tests.

---

## 3. File tour

Twelve files explain 90% of the system.

| File | One-line role |
|---|---|
| `supabase/migrations/20260421120000_init.sql` | Schema, RLS policies, `match_chunks` RPC, HNSW index. |
| `supabase/migrations/20260421120100_storage.sql` | Private `sources` bucket + per-user object policies. |
| `backend/app/core/auth.py` | JWT verification (HS256 + JWKS) → user-scoped Supabase client. |
| `backend/app/ingestion/chunker.py` | Token-aware recursive chunker. |
| `backend/app/ingestion/pdf.py` | PyMuPDF text + OpenAI Vision OCR fallback. |
| `backend/app/ingestion/url.py` | httpx + trafilatura with typed failure modes. |
| `backend/app/rag/chat.py` | Four-stage orchestrator, SSE event emitter. |
| `backend/app/api/sources.py` | CRUD for sources, schedules background ingestion. |
| `app/globals.css` | Design tokens, utilities, `answer-prose`. |
| `components/app-shell.tsx` | Sidebar, conversation list, account + sign-out. |
| `app/app/chat/[id]/chat-view.tsx` | SSE consumer, markdown answer + citation pills, composer. |
| `app/auth/actions.ts` | Server Actions for sign-in / sign-up / sign-out with friendly network errors. |

---

## 4. Known trade-offs (honestly)

These are conscious choices, not oversights — they're the things I'd change
next if this were going to production:

1. **Ingestion runs in-process** (FastAPI BackgroundTasks). Good enough for
   a demo; a real deployment wants `arq`/`dramatiq`/Celery with a retry
   queue and a separate worker pool.
2. **Polling for source status**. A Supabase Realtime subscription would be
   instant and cheaper.
3. **Dense-only retrieval**. A hybrid BM25 + dense fusion (RRF) would
   improve recall on exact-match queries like SKU codes.
4. **Vision OCR is slow on large scanned PDFs**. A local Tesseract fallback
   or batched vision calls would help.
5. **No rate limiting** beyond whatever OpenAI enforces.
6. **No cost display** — a per-user token meter would be trivial to add
   given every embeddings + chat call is already wrapped.

See §10 of [README.md](./README.md) for the full "what I'd improve with more
time" list.

---

## 5. How to explore the code in order

If you're reviewing this and want a guided path through the source:

1. **Start with the data model**
   `supabase/migrations/20260421120000_init.sql` →
   `supabase/migrations/20260421120100_storage.sql`
2. **Then the auth boundary**
   `backend/app/core/auth.py` → `lib/supabase/proxy.ts` → `proxy.ts`
3. **Ingestion vertical**
   `backend/app/api/sources.py` → `backend/app/ingestion/pipeline.py`
   → one of `text.py` / `pdf.py` / `url.py`
4. **RAG vertical**
   `backend/app/rag/retrieval.py` → `backend/app/rag/prompts.py` →
   `backend/app/rag/chat.py`
5. **Frontend stream consumer**
   `lib/api.ts` (look for `chat.stream`) → `app/app/chat/[id]/chat-view.tsx`
6. **Design system**
   `app/globals.css` (tokens + utilities) → `components/app-shell.tsx`
   → `app/sign-in/page.tsx` (editorial layout example)

That order mirrors request flow: data → auth → write path → read path → UI.

# ChatBrain backend

FastAPI service that owns:

- Supabase JWT verification
- Multi-source ingestion (PDF / text / URL) with OCR fallback for scanned PDFs
- Chunking + OpenAI embeddings
- RAG retrieval + streaming chat with visible reasoning

## Run locally

```bash
cd backend
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
# macOS / Linux
# source .venv/bin/activate

pip install -e ".[dev]"
cp .env.example .env   # then fill in real values

uvicorn app.main:app --reload --port 8000
```

`http://localhost:8000/docs` for interactive OpenAPI.

## Tests

```bash
pytest
```

## Layout

```
app/
  core/         # config, logging, Supabase clients, auth dependency
  ingestion/    # chunker, embedder, per-type extractors, pipeline
  rag/          # retrieval, prompts, streaming chat orchestration
  api/          # sources, conversations, chat routers
```

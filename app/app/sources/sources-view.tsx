"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type SourceRow } from "@/lib/api";

type Tab = "text" | "pdf" | "url";

export function SourcesView() {
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [tab, setTab] = useState<Tab>("text");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.sources.list();
      setSources(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sources.");
    }
  }, []);

  // Initial load — canonical inline-async pattern with a cancel flag so a
  // fast unmount doesn't call setState on a dead component.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.sources.list();
        if (!cancelled) {
          setSources(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load sources.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll every 2s while anything is still being processed.
  useEffect(() => {
    const anyPending = sources?.some(
      (s) => s.status === "pending" || s.status === "processing",
    );
    if (!anyPending) return;
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [sources, refresh]);

  const onAdded = async (row: SourceRow) => {
    setSources((prev) => (prev ? [row, ...prev] : [row]));
  };

  const onDelete = async (id: string) => {
    const prev = sources;
    setSources((s) => s?.filter((r) => r.id !== id) ?? null);
    try {
      await api.sources.remove(id);
    } catch (e) {
      setSources(prev ?? null);
      setError(e instanceof Error ? e.message : "Delete failed.");
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-surface">
        <div className="flex border-b border-border overflow-x-auto">
          <TabButton active={tab === "text"} onClick={() => setTab("text")}>
            Paste text
          </TabButton>
          <TabButton active={tab === "pdf"} onClick={() => setTab("pdf")}>
            Upload PDF
          </TabButton>
          <TabButton active={tab === "url"} onClick={() => setTab("url")}>
            Add URL
          </TabButton>
        </div>
        <div className="p-4">
          {tab === "text" ? <AddTextForm onAdded={onAdded} /> : null}
          {tab === "pdf" ? <AddPdfForm onAdded={onAdded} /> : null}
          {tab === "url" ? <AddUrlForm onAdded={onAdded} /> : null}
        </div>
      </section>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-medium text-foreground-muted uppercase tracking-wider">
            Sources {sources ? `(${sources.length})` : ""}
          </h2>
        </div>
        {sources === null ? (
          <div className="text-sm text-foreground-muted">Loading…</div>
        ) : sources.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-2">
            {sources.map((s) => (
              <SourceItem key={s.id} source={s} onDelete={() => onDelete(s.id)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-3 text-sm font-medium border-b-2 transition whitespace-nowrap ${
        active
          ? "border-accent text-foreground"
          : "border-transparent text-foreground-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Add forms
// ──────────────────────────────────────────────────────────────────────────
function AddTextForm({ onAdded }: { onAdded: (row: SourceRow) => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await api.sources.createText(title.trim(), content);
      onAdded(row);
      setTitle("");
      setContent("");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not create source.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (e.g. Return policy SOP)"
        maxLength={200}
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Paste any text: an SOP, notes, a doc…"
        rows={8}
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end">
        <SubmitBtn disabled={submitting || !title.trim() || !content.trim()}>
          {submitting ? "Adding…" : "Add text source"}
        </SubmitBtn>
      </div>
    </form>
  );
}

function AddPdfForm({ onAdded }: { onAdded: (row: SourceRow) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await api.sources.createPdf(file, title.trim() || undefined);
      onAdded(row);
      setFile(null);
      setTitle("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block">
        <span className="block text-sm text-foreground-muted mb-1">
          PDF file
        </span>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent file:text-[#0b0d12] file:px-3 file:py-2 file:font-medium file:cursor-pointer hover:file:bg-accent-strong"
        />
      </label>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional, defaults to file name)"
        maxLength={200}
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      <p className="text-xs text-foreground-muted">
        Up to 50 MB. Scanned PDFs are transcribed via OCR.
      </p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end">
        <SubmitBtn disabled={submitting || !file}>
          {submitting ? "Uploading…" : "Upload"}
        </SubmitBtn>
      </div>
    </form>
  );
}

function AddUrlForm({ onAdded }: { onAdded: (row: SourceRow) => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await api.sources.createUrl(url.trim(), title.trim() || undefined);
      onAdded(row);
      setUrl("");
      setTitle("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add URL.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://example.com/your-article"
        required
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional, auto-detected from page)"
        maxLength={200}
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end">
        <SubmitBtn disabled={submitting || !url.trim()}>
          {submitting ? "Scraping…" : "Add URL"}
        </SubmitBtn>
      </div>
    </form>
  );
}

function SubmitBtn({
  children,
  disabled,
}: {
  children: React.ReactNode;
  disabled: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="rounded-md bg-accent hover:bg-accent-strong text-[#0b0d12] font-medium px-4 py-2 text-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Source list item
// ──────────────────────────────────────────────────────────────────────────
function SourceItem({
  source,
  onDelete,
}: {
  source: SourceRow;
  onDelete: () => void;
}) {
  const created = useMemo(
    () => new Date(source.created_at).toLocaleString(),
    [source.created_at],
  );

  return (
    <li className="rounded-lg border border-border bg-surface px-4 py-3 flex items-start gap-3">
      <TypeBadge type={source.type} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-medium">{source.title}</h3>
          <StatusPill status={source.status} />
        </div>
        <div className="mt-1 text-xs text-foreground-muted flex items-center gap-2 flex-wrap">
          <span>{created}</span>
          {source.url ? (
            <>
              <span>·</span>
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="truncate hover:text-foreground underline-offset-2 hover:underline max-w-[22rem]"
              >
                {source.url}
              </a>
            </>
          ) : null}
          {source.status === "ready" ? (
            <>
              <span>·</span>
              <span>{source.chunk_count} chunks</span>
            </>
          ) : null}
        </div>
        {source.status === "failed" && source.error ? (
          <p className="mt-2 text-sm text-danger">{source.error}</p>
        ) : null}
      </div>
      <button
        onClick={onDelete}
        aria-label="Delete source"
        className="shrink-0 rounded-md p-2 text-foreground-muted hover:text-danger hover:bg-danger/10 transition"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"
          />
        </svg>
      </button>
    </li>
  );
}

function TypeBadge({ type }: { type: SourceRow["type"] }) {
  const label = type.toUpperCase();
  const color =
    type === "pdf"
      ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
      : type === "url"
        ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
        : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  return (
    <span
      className={`inline-flex items-center justify-center text-[10px] font-semibold border rounded-md w-11 py-0.5 ${color}`}
    >
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: SourceRow["status"] }) {
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" /> failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-warning">
      <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />{" "}
      {status === "pending" ? "queued" : "processing"}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border-strong bg-surface/40 p-8 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-accent">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 5v14M5 12h14"
          />
        </svg>
      </div>
      <h3 className="font-medium">No sources yet</h3>
      <p className="mt-1 text-sm text-foreground-muted">
        Add some knowledge above, then head to chat.
      </p>
    </div>
  );
}

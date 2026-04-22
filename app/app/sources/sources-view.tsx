"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type SourceRow } from "@/lib/api";

type Tab = "text" | "pdf" | "url";

const TAB_DEFS: { id: Tab; label: string; hint: string }[] = [
  { id: "text", label: "Paste text", hint: "Notes, SOPs, transcripts" },
  { id: "pdf", label: "Upload PDF", hint: "Papers, reports, scans" },
  { id: "url", label: "Add URL", hint: "Articles, docs, posts" },
];

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

  // Poll while anything is still ingesting — kept short so users see the
  // status flip to "ready" quickly without flooding the API.
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

  const readyCount = sources?.filter((s) => s.status === "ready").length ?? 0;
  const totalCount = sources?.length ?? 0;

  return (
    <div className="space-y-8">
      {/* Composer */}
      <section className="surface-elevated rounded-2xl overflow-hidden">
        <div
          role="tablist"
          aria-label="Source type"
          className="flex border-b border-border overflow-x-auto"
        >
          {TAB_DEFS.map((t) => (
            <TabButton
              key={t.id}
              active={tab === t.id}
              onClick={() => setTab(t.id)}
              label={t.label}
              hint={t.hint}
            />
          ))}
        </div>
        <div className="p-5 md:p-6">
          {tab === "text" ? <AddTextForm onAdded={onAdded} /> : null}
          {tab === "pdf" ? <AddPdfForm onAdded={onAdded} /> : null}
          {tab === "url" ? <AddUrlForm onAdded={onAdded} /> : null}
        </div>
      </section>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {error}
        </div>
      ) : null}

      {/* Source list */}
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-foreground-subtle">
            Sources
          </h2>
          {sources && sources.length > 0 ? (
            <span className="text-xs text-foreground-muted tabular-nums">
              <span className="text-foreground font-medium">{readyCount}</span>
              <span className="text-foreground-subtle"> of </span>
              <span className="text-foreground font-medium">{totalCount}</span>
              <span className="text-foreground-subtle"> ready</span>
            </span>
          ) : null}
        </div>

        {sources === null ? (
          <div className="space-y-2">
            <div className="skeleton h-[68px]" />
            <div className="skeleton h-[68px]" />
            <div className="skeleton h-[68px]" />
          </div>
        ) : sources.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-2">
            {sources.map((s) => (
              <SourceItem
                key={s.id}
                source={s}
                onDelete={() => onDelete(s.id)}
              />
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
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex-1 min-w-[140px] px-4 py-3.5 text-left whitespace-nowrap ${
        active
          ? "text-foreground"
          : "text-foreground-muted hover:text-foreground"
      }`}
      style={{
        transition:
          "color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)",
      }}
    >
      <span className="block text-sm font-medium">{label}</span>
      <span className="block text-[11.5px] text-foreground-subtle mt-0.5">
        {hint}
      </span>
      <span
        aria-hidden
        className={`absolute left-0 right-0 -bottom-px h-[2px] ${
          active ? "bg-accent" : "bg-transparent"
        }`}
        style={{ transition: "background-color var(--dur-fast) var(--ease-out)" }}
      />
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
    <form onSubmit={onSubmit} className="space-y-3.5">
      <LabeledInput
        label="Title"
        value={title}
        onChange={setTitle}
        placeholder="e.g. Return policy SOP"
        maxLength={200}
      />
      <label className="block">
        <span className="block text-[13px] font-medium text-foreground mb-1.5">
          Content
        </span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste any text: an SOP, notes, a transcript…"
          rows={10}
          className="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:border-accent/60"
          style={{
            transition:
              "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
          }}
        />
      </label>
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] text-foreground-subtle">
          We chunk long text automatically before embedding.
        </span>
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
    <form onSubmit={onSubmit} className="space-y-3.5">
      <label className="block">
        <span className="block text-[13px] font-medium text-foreground mb-1.5">
          PDF file
        </span>
        <div className="relative rounded-md border border-dashed border-border-strong bg-surface-2/60 hover:border-accent/60 px-4 py-5 flex items-center gap-3"
             style={{ transition: "border-color var(--dur-fast) var(--ease-out)" }}>
          <div className="h-9 w-9 shrink-0 rounded-md bg-surface border border-border grid place-items-center text-accent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6z"
              />
              <path
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M14 3v6h6"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-foreground truncate">
              {file ? file.name : "Choose a PDF"}
            </div>
            <div className="text-[11.5px] text-foreground-subtle mt-0.5">
              {file
                ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
                : "Up to 50 MB. Scanned pages are transcribed via OCR."}
            </div>
          </div>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="absolute inset-0 opacity-0 cursor-pointer"
            aria-label="Choose PDF file"
          />
        </div>
      </label>
      <LabeledInput
        label="Title"
        value={title}
        onChange={setTitle}
        placeholder="Optional — defaults to the file name"
        maxLength={200}
        optional
      />
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] text-foreground-subtle">
          Ingestion runs in the background — you can keep working.
        </span>
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
      const row = await api.sources.createUrl(
        url.trim(),
        title.trim() || undefined,
      );
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
    <form onSubmit={onSubmit} className="space-y-3.5">
      <label className="block">
        <span className="block text-[13px] font-medium text-foreground mb-1.5">
          URL
        </span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/your-article"
          required
          className="w-full h-11 rounded-md border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-accent/60"
          style={{
            transition:
              "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
          }}
        />
      </label>
      <LabeledInput
        label="Title"
        value={title}
        onChange={setTitle}
        placeholder="Optional — we'll use the page title if empty"
        maxLength={200}
        optional
      />
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] text-foreground-subtle">
          We scrape the main article body — no login-gated content.
        </span>
        <SubmitBtn disabled={submitting || !url.trim()}>
          {submitting ? "Scraping…" : "Add URL"}
        </SubmitBtn>
      </div>
    </form>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  optional?: boolean;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-2 mb-1.5">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {optional ? (
          <span className="text-[10.5px] uppercase tracking-wider text-foreground-subtle">
            Optional
          </span>
        ) : null}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full h-11 rounded-md border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-accent/60"
        style={{
          transition:
            "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
        }}
      />
    </label>
  );
}

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      {children}
    </p>
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
      className="rounded-md bg-accent hover:bg-accent-strong text-[#0b0d12] font-medium px-4 h-10 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
      style={{
        transition:
          "background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)",
      }}
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
    <li
      className="group rounded-lg border border-border bg-surface hover:border-border-strong px-4 py-3.5 flex items-start gap-4"
      style={{
        transition:
          "border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
      }}
    >
      <TypeBadge type={source.type} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-medium text-[14.5px] text-foreground truncate max-w-full">
            {source.title}
          </h3>
          <StatusPill status={source.status} />
        </div>
        <div className="mt-1 text-[12px] text-foreground-subtle flex items-center gap-2 flex-wrap">
          <span>{created}</span>
          {source.url ? (
            <>
              <Dot />
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="truncate hover:text-foreground underline-offset-2 hover:underline max-w-[22rem]"
                style={{ transition: "color var(--dur-fast) var(--ease-out)" }}
              >
                {source.url}
              </a>
            </>
          ) : null}
          {source.status === "ready" ? (
            <>
              <Dot />
              <span className="tabular-nums">{source.chunk_count} chunks</span>
            </>
          ) : null}
        </div>
        {source.status === "failed" && source.error ? (
          <p className="mt-2 text-sm text-danger">{source.error}</p>
        ) : null}
      </div>
      <button
        onClick={onDelete}
        aria-label={`Delete ${source.title}`}
        className="shrink-0 rounded-md p-2 text-foreground-subtle hover:text-danger hover:bg-danger/10"
        style={{
          transition:
            "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"
          />
        </svg>
      </button>
    </li>
  );
}

function Dot() {
  return <span aria-hidden className="text-foreground-subtle">·</span>;
}

function TypeBadge({ type }: { type: SourceRow["type"] }) {
  const label = type.toUpperCase();
  // Subtle, desaturated token per type — same chromatic family, different hue.
  const cls =
    type === "pdf"
      ? "bg-rose-500/10 text-rose-300 border-rose-500/25"
      : type === "url"
        ? "bg-sky-500/10 text-sky-300 border-sky-500/25"
        : "bg-emerald-500/10 text-emerald-300 border-emerald-500/25";
  return (
    <span
      className={`mt-0.5 inline-flex items-center justify-center text-[10px] font-mono font-semibold border rounded-md w-11 py-1 ${cls}`}
    >
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: SourceRow["status"] }) {
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" /> failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-warning">
      <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />
      {status === "pending" ? "queued" : "processing"}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="relative rounded-2xl border border-dashed border-border-strong bg-surface/40 p-10 text-center overflow-hidden">
      <div aria-hidden className="absolute inset-0 dot-grid opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      <div className="relative">
        <div className="mx-auto mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent border border-accent/25">
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
        <h3 className="text-base font-semibold text-foreground">
          Your brain is empty
        </h3>
        <p className="mt-1 text-sm text-foreground-muted max-w-md mx-auto">
          Add your first source above — a PDF, a note, or a link. Once it&rsquo;s
          ready, head over to chat and ask it anything.
        </p>
      </div>
    </div>
  );
}

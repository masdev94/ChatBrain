"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type SourceRow, type SourceType } from "@/lib/api";

type Tab = "text" | "pdf" | "url";
type TypeFilter = "all" | SourceType;

const TAB_DEFS: {
  id: Tab;
  label: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "text",
    label: "Paste text",
    hint: "Notes, SOPs, transcripts",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5 5h14M5 10h14M5 15h10M5 20h7"
        />
      </svg>
    ),
  },
  {
    id: "pdf",
    label: "Upload PDF",
    hint: "Papers, reports, scans",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
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
    ),
  },
  {
    id: "url",
    label: "Add URL",
    hint: "Articles, docs, posts",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M10 14a4 4 0 015.66 0l3-3a4 4 0 10-5.66-5.66L11 7"
        />
        <path
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14 10a4 4 0 01-5.66 0l-3 3a4 4 0 105.66 5.66L13 17"
        />
      </svg>
    ),
  },
];

export function SourcesView() {
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [tab, setTab] = useState<Tab>("text");
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SourceRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  // List filtering & a transient ring on freshly-added items.
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

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
    // Briefly ring the new card so the user sees where it landed. Reset any
    // pending highlight first so two quick adds don't fight each other.
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
    }
    setHighlightedId(row.id);
    highlightTimer.current = window.setTimeout(() => {
      setHighlightedId(null);
      highlightTimer.current = null;
    }, 2000);
    // If the active filter would hide the new row, drop it back to "all" so
    // the user actually sees what they just added.
    if (typeFilter !== "all" && typeFilter !== row.type) {
      setTypeFilter("all");
    }
    if (query.trim()) setQuery("");
  };

  useEffect(() => {
    return () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    };
  }, []);

  const onConfirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setDeleting(true);
    const prev = sources;
    setSources((s) => s?.filter((r) => r.id !== target.id) ?? null);
    try {
      await api.sources.remove(target.id);
      setPendingDelete(null);
    } catch (e) {
      setSources(prev ?? null);
      setError(e instanceof Error ? e.message : "Delete failed.");
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const readyCount = sources?.filter((s) => s.status === "ready").length ?? 0;
  const failedCount = sources?.filter((s) => s.status === "failed").length ?? 0;
  const totalCount = sources?.length ?? 0;

  // Type counts power the filter pills' badges. Computed against the *full*
  // list so the user can always see what kinds of sources they have.
  const typeCounts = useMemo(() => {
    const counts: Record<TypeFilter, number> = {
      all: totalCount,
      text: 0,
      pdf: 0,
      url: 0,
    };
    for (const s of sources ?? []) counts[s.type] += 1;
    return counts;
  }, [sources, totalCount]);

  const visibleSources = useMemo(() => {
    if (!sources) return null;
    const q = query.trim().toLowerCase();
    return sources.filter((s) => {
      if (typeFilter !== "all" && s.type !== typeFilter) return false;
      if (!q) return true;
      const inTitle = s.title.toLowerCase().includes(q);
      const inUrl = s.url ? s.url.toLowerCase().includes(q) : false;
      return inTitle || inUrl;
    });
  }, [sources, typeFilter, query]);

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
              icon={t.icon}
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
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-foreground-subtle">
              Sources
            </h2>
            {failedCount > 0 ? (
              <span
                role="status"
                title="Failed sources are auto-expanded so you can inspect them"
                className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10.5px] font-medium text-danger"
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />
                {failedCount} failed
              </span>
            ) : null}
          </div>
          {sources && sources.length > 0 ? (
            <span className="text-xs text-foreground-muted tabular-nums">
              <span className="text-foreground font-medium">{readyCount}</span>
              <span className="text-foreground-subtle"> of </span>
              <span className="text-foreground font-medium">{totalCount}</span>
              <span className="text-foreground-subtle"> ready</span>
            </span>
          ) : null}
        </div>

        {/* Filter bar — appears once the library has any meaningful size so
            tiny libraries stay clean. */}
        {sources && sources.length >= 3 ? (
          <FilterBar
            typeFilter={typeFilter}
            onTypeChange={setTypeFilter}
            counts={typeCounts}
            query={query}
            onQueryChange={setQuery}
          />
        ) : null}

        {sources === null ? (
          <div className="space-y-2">
            <div className="skeleton h-[68px]" />
            <div className="skeleton h-[68px]" />
            <div className="skeleton h-[68px]" />
          </div>
        ) : sources.length === 0 ? (
          <EmptyState />
        ) : visibleSources && visibleSources.length === 0 ? (
          <NoResultsState
            onClear={() => {
              setTypeFilter("all");
              setQuery("");
            }}
          />
        ) : (
          <ul className="space-y-2">
            {(visibleSources ?? []).map((s) => (
              <SourceItem
                key={s.id}
                source={s}
                highlighted={s.id === highlightedId}
                onRequestDelete={() => setPendingDelete(s)}
              />
            ))}
          </ul>
        )}
      </section>

      {pendingDelete ? (
        <ConfirmDeleteDialog
          source={pendingDelete}
          busy={deleting}
          onCancel={() => (deleting ? null : setPendingDelete(null))}
          onConfirm={onConfirmDelete}
        />
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  hint,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex-1 min-w-[140px] px-4 py-3.5 flex items-center gap-3 text-left whitespace-nowrap ${
        active
          ? "text-foreground bg-surface"
          : "text-foreground-muted hover:text-foreground hover:bg-surface-2/40"
      }`}
      style={{
        transition:
          "color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border ${
          active
            ? "border-accent/30 bg-accent/10 text-accent"
            : "border-border bg-surface-2/60 text-foreground-subtle"
        }`}
        style={{
          transition:
            "background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
        }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11.5px] text-foreground-subtle mt-0.5 truncate">
          {hint}
        </span>
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
// Filter bar — type pills + search input
// ──────────────────────────────────────────────────────────────────────────
function FilterBar({
  typeFilter,
  onTypeChange,
  counts,
  query,
  onQueryChange,
}: {
  typeFilter: TypeFilter;
  onTypeChange: (t: TypeFilter) => void;
  counts: Record<TypeFilter, number>;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const pills: { id: TypeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "text", label: "Text" },
    { id: "pdf", label: "PDF" },
    { id: "url", label: "URL" },
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 justify-between">
      <div
        role="tablist"
        aria-label="Filter by type"
        className="inline-flex items-center gap-1 rounded-lg bg-surface-2/40 border border-border p-1"
      >
        {pills.map((p) => {
          const active = typeFilter === p.id;
          const disabled = p.id !== "all" && counts[p.id] === 0;
          return (
            <button
              key={p.id}
              role="tab"
              aria-selected={active}
              type="button"
              disabled={disabled}
              onClick={() => onTypeChange(p.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 h-7 text-[12px] font-medium ${
                active
                  ? "bg-surface text-foreground shadow-sm"
                  : disabled
                    ? "text-foreground-subtle/60 cursor-not-allowed"
                    : "text-foreground-muted hover:text-foreground hover:bg-surface/60"
              }`}
              style={{
                transition:
                  "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
              }}
            >
              {p.label}
              <span
                className={`tabular-nums text-[10.5px] ${
                  active ? "text-foreground-muted" : "text-foreground-subtle"
                }`}
              >
                {counts[p.id]}
              </span>
            </button>
          );
        })}
      </div>

      <label className="relative flex-1 min-w-[160px] sm:max-w-xs">
        <span className="sr-only">Search sources</span>
        <span
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-subtle"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <circle
              cx="11"
              cy="11"
              r="7"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              d="M20 20l-3.5-3.5"
            />
          </svg>
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by title or URL…"
          className="w-full h-8 rounded-md border border-border bg-surface-2/40 pl-8 pr-7 text-[12.5px] text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-accent/60 focus:bg-surface-2"
          style={{
            transition:
              "border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)",
          }}
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface"
            style={{
              transition:
                "color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)",
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                d="M6 6l12 12M18 6L6 18"
              />
            </svg>
          </button>
        ) : null}
      </label>
    </div>
  );
}

function NoResultsState({ onClear }: { onClear: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface/40 px-5 py-8 text-center">
      <div className="mx-auto mb-2 inline-flex h-9 w-9 items-center justify-center rounded-md bg-surface-2 text-foreground-subtle">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
          <path
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            d="M20 20l-3.5-3.5"
          />
        </svg>
      </div>
      <p className="text-[13px] text-foreground">No matching sources</p>
      <p className="mt-1 text-[12px] text-foreground-subtle">
        Try a different search or type filter.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2/60 px-2.5 py-1 text-[12px] text-foreground-muted hover:text-foreground hover:bg-surface-2"
        style={{
          transition:
            "color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)",
        }}
      >
        Clear filters
      </button>
    </div>
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
        <span className="flex items-center justify-between mb-1.5">
          <span className="text-[13px] font-medium text-foreground">
            Content
          </span>
          <span className="text-[10.5px] text-foreground-subtle tabular-nums">
            {content.length.toLocaleString()} chars
          </span>
        </span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl + Enter submits — saves a trip to the mouse for power
            // users pasting walls of text.
            if (
              (e.metaKey || e.ctrlKey) &&
              e.key === "Enter" &&
              title.trim() &&
              content.trim() &&
              !submitting
            ) {
              e.preventDefault();
              (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
            }
          }}
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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[11.5px] text-foreground-subtle">
          We chunk long text automatically before embedding.
        </span>
        <div className="flex items-center gap-2.5">
          <span
            className="hidden sm:inline-flex items-center gap-1 text-[10.5px] text-foreground-subtle"
            aria-hidden
          >
            <Kbd>{isMac() ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>↵</Kbd>
            <span>to add</span>
          </span>
          <SubmitBtn disabled={submitting || !title.trim() || !content.trim()}>
            {submitting ? "Adding…" : "Add text source"}
          </SubmitBtn>
        </div>
      </div>
    </form>
  );
}

/** Keyboard cap — used in helper hints. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded border border-border bg-surface-2/60 font-sans text-[10px] text-foreground-muted">
      {children}
    </kbd>
  );
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

function AddPdfForm({ onAdded }: { onAdded: (row: SourceRow) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while the user is dragging a file over the drop zone — used to
  // animate the border/background to make it obvious where to release.
  const [dragOver, setDragOver] = useState(false);
  // Counter to handle nested dragenter/leave events (which fire for child
  // elements and would otherwise flicker the dragOver state).
  const dragDepth = useRef(0);

  const acceptFile = (f: File | null | undefined) => {
    if (!f) return;
    if (f.type && f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      setError("That file isn't a PDF.");
      return;
    }
    setError(null);
    setFile(f);
  };

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
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current += 1;
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            // Hint to the OS this is a copy operation.
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragOver(false);
            const dropped = e.dataTransfer.files?.[0];
            acceptFile(dropped);
          }}
          className={`relative rounded-md border-2 border-dashed px-4 py-5 flex items-center gap-3 ${
            dragOver
              ? "border-accent bg-accent/8"
              : file
                ? "border-border bg-surface-2/60 hover:border-border-strong"
                : "border-border-strong bg-surface-2/40 hover:border-accent/60 hover:bg-surface-2/60"
          }`}
          style={{
            transition:
              "border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)",
          }}
        >
          <div
            className={`h-9 w-9 shrink-0 rounded-md border grid place-items-center ${
              dragOver
                ? "border-accent/40 bg-accent/15 text-accent"
                : file
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-border bg-surface text-accent"
            }`}
            style={{
              transition:
                "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
            }}
          >
            {file ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 12l5 5L20 7"
                />
              </svg>
            ) : (
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
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm text-foreground truncate">
              {dragOver
                ? "Drop to upload"
                : file
                  ? file.name
                  : "Drag & drop a PDF, or click to browse"}
            </div>
            <div className="text-[11.5px] text-foreground-subtle mt-0.5">
              {file
                ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
                : "Up to 50 MB. Scanned pages are transcribed via OCR."}
            </div>
          </div>
          {file ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setFile(null);
              }}
              aria-label="Remove file"
              className="relative z-10 shrink-0 grid h-7 w-7 place-items-center rounded-md text-foreground-subtle hover:text-foreground hover:bg-surface-2"
              style={{
                transition:
                  "color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  d="M6 6l12 12M18 6L6 18"
                />
              </svg>
            </button>
          ) : null}
          {/* The native input fills the zone so click-to-browse still works.
              Disabled when a file is already chosen so the remove button
              isn't shadowed by the input. */}
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => acceptFile(e.target.files?.[0])}
            className={`absolute inset-0 opacity-0 ${
              file ? "pointer-events-none" : "cursor-pointer"
            }`}
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
// A collapsible card:
//   • Header (always visible) — type icon, title, status pill, chevron, delete
//   • Body (collapsible)      — summary, URL link, failure detail, facts row
// We auto-expand failed sources so the user notices the error immediately.
// ──────────────────────────────────────────────────────────────────────────
function SourceItem({
  source,
  highlighted,
  onRequestDelete,
}: {
  source: SourceRow;
  highlighted?: boolean;
  onRequestDelete: () => void;
}) {
  const failed = source.status === "failed";
  const [expanded, setExpanded] = useState(failed);

  const created = useMemo(
    () => formatRelative(source.created_at),
    [source.created_at],
  );
  const summary = typeof source.metadata?.summary === "string"
    ? source.metadata.summary
    : "";
  const showSummarySkeleton =
    !summary &&
    (source.status === "pending" || source.status === "processing");
  const facts = useMemo(() => buildFacts(source), [source]);
  const hasBody =
    Boolean(summary) || showSummarySkeleton || Boolean(source.url) ||
    facts.length > 0 || (failed && Boolean(source.error));

  return (
    <li
      className={`group rounded-xl border bg-surface hover:border-border-strong ${
        highlighted
          ? "border-accent/50 ring-2 ring-accent/20"
          : "border-border"
      }`}
      style={{
        transition:
          "border-color var(--dur-med) var(--ease-out), background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-med) var(--ease-out)",
      }}
    >
      {/* Header — clickable as a single button to toggle expansion. */}
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => hasBody && setExpanded((v) => !v)}
          aria-expanded={hasBody ? expanded : undefined}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${source.title}`}
          disabled={!hasBody}
          className="flex flex-1 items-center gap-3.5 px-5 py-4 text-left min-w-0 rounded-l-xl disabled:cursor-default cursor-pointer"
        >
          <TypeIcon type={source.type} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5">
              <h3 className="font-semibold text-[15px] text-foreground truncate tracking-[-0.005em]">
                {source.title}
              </h3>
              <StatusPill status={source.status} />
            </div>
            <div className="mt-0.5 text-[11.5px] text-foreground-subtle truncate">
              {created}
              {source.url ? (
                <>
                  <span className="px-1.5">·</span>
                  <span className="text-foreground-subtle">
                    {prettyUrl(source.url)}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          {hasBody ? (
            <Chevron expanded={expanded} />
          ) : null}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete();
          }}
          aria-label={`Delete ${source.title}`}
          className="shrink-0 mr-3 my-auto rounded-md p-1.5 text-foreground-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger hover:bg-danger/10"
          style={{
            transition:
              "opacity var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"
            />
          </svg>
        </button>
      </div>

      {/* Collapsible body — animates height via the grid-rows fr trick. */}
      <div
        className={`grid overflow-hidden ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
        style={{
          transition:
            "grid-template-rows var(--dur-med) var(--ease-out)",
        }}
        aria-hidden={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-5 pb-4 ml-[44px] space-y-3 border-t border-border/60 pt-3">
            {summary ? (
              <p className="text-[13.5px] leading-relaxed text-foreground-muted">
                {summary}
              </p>
            ) : showSummarySkeleton ? (
              <div className="space-y-1.5">
                <div className="skeleton h-3 w-[92%]" />
                <div className="skeleton h-3 w-[68%]" />
              </div>
            ) : null}

            {failed && source.error ? (
              <p className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[12.5px] text-danger">
                {source.error}
              </p>
            ) : null}

            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:text-accent-strong underline-offset-2 hover:underline truncate max-w-full"
                style={{ transition: "color var(--dur-fast) var(--ease-out)" }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14 3h7v7M10 14L21 3M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5"
                  />
                </svg>
                <span className="truncate">{source.url}</span>
              </a>
            ) : null}

            {facts.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {facts.map((f) => (
                  <Fact key={f.label} icon={f.icon} label={f.label} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Tiny chevron that rotates on expand. */
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0 text-foreground-subtle group-hover:text-foreground-muted"
      style={{
        transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
        transition:
          "transform var(--dur-med) var(--ease-out), color var(--dur-fast) var(--ease-out)",
      }}
    >
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 9l6 6 6-6"
      />
    </svg>
  );
}

/** Round, accent-tinted icon tile that visually anchors each card. */
function TypeIcon({ type }: { type: SourceRow["type"] }) {
  const palette =
    type === "pdf"
      ? "bg-rose-500/10 text-rose-300 border-rose-500/20"
      : type === "url"
        ? "bg-sky-500/10 text-sky-300 border-sky-500/20"
        : "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
  return (
    <span
      aria-hidden
      className={`shrink-0 mt-0.5 grid h-8 w-8 place-items-center rounded-lg border ${palette}`}
    >
      {type === "pdf" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
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
      ) : type === "url" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10 14a4 4 0 015.66 0l3-3a4 4 0 10-5.66-5.66L11 7"
          />
          <path
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14 10a4 4 0 01-5.66 0l-3 3a4 4 0 105.66 5.66L13 17"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 5h14M5 10h14M5 15h10M5 20h7"
          />
        </svg>
      )}
    </span>
  );
}

function StatusPill({ status }: { status: SourceRow["status"] }) {
  if (status === "ready") {
    return (
      <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[10.5px] font-medium text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> Ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10.5px] font-medium text-danger">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" /> Failed
      </span>
    );
  }
  return (
    <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[10.5px] font-medium text-warning">
      <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />
      {status === "pending" ? "Queued" : "Processing"}
    </span>
  );
}

/** Compact metadata pill — icon + label, used in the card footer. */
function Fact({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2/60 px-2 py-0.5 text-[11px] text-foreground-muted">
      <span aria-hidden className="text-foreground-subtle">{icon}</span>
      <span className="tabular-nums">{label}</span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function buildFacts(
  source: SourceRow,
): { label: string; icon: React.ReactNode }[] {
  const facts: { label: string; icon: React.ReactNode }[] = [];
  const m = source.metadata ?? {};

  if (source.status === "ready" && source.chunk_count > 0) {
    facts.push({
      label: `${source.chunk_count} chunk${source.chunk_count === 1 ? "" : "s"}`,
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 6h16M4 12h16M4 18h10"
          />
        </svg>
      ),
    });
  }

  if (typeof m.page_count === "number" && m.page_count > 0) {
    facts.push({
      label: `${m.page_count} page${m.page_count === 1 ? "" : "s"}`,
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6z"
          />
        </svg>
      ),
    });
  }

  if (typeof m.ocr_pages === "number" && m.ocr_pages > 0) {
    facts.push({
      label: `${m.ocr_pages} OCR`,
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="2" />
          <path
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
          />
        </svg>
      ),
    });
  }

  if (typeof m.domain === "string" && m.domain) {
    facts.push({
      label: m.domain,
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path
            stroke="currentColor"
            strokeWidth="2"
            d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"
          />
        </svg>
      ),
    });
  }

  if (typeof m.char_count === "number" && m.char_count > 0) {
    facts.push({
      label: `${formatCount(m.char_count)} chars`,
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 7V4h16v3M9 20h6M12 4v16"
          />
        </svg>
      ),
    });
  }

  return facts;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function prettyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/$/, "");
    return `${u.host}${path}`;
  } catch {
    return raw;
  }
}

/** Compact relative time — "2m ago", "3h ago", "Apr 12". */
function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ──────────────────────────────────────────────────────────────────────────
// Delete confirmation modal
// ──────────────────────────────────────────────────────────────────────────
function ConfirmDeleteDialog({
  source,
  busy,
  onCancel,
  onConfirm,
}: {
  source: SourceRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Close on Escape — but ignore while the delete is in flight so the user
  // doesn't end up with a half-finished operation and a closed dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  // Lock body scroll while the modal is open.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
      className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/60 backdrop-blur-sm fade-up"
      onClick={() => (busy ? null : onCancel())}
      style={{ animationDuration: "var(--dur-med)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="surface-elevated rounded-xl p-5 md:p-6 w-full max-w-md"
      >
        <div className="flex items-start gap-3.5">
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-danger/25 bg-danger/10 text-danger"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="confirm-delete-title"
              className="text-[15px] font-semibold text-foreground"
            >
              Delete this source?
            </h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-foreground-muted">
              <span className="block truncate font-medium text-foreground">
                {source.title}
              </span>
              All extracted text, embeddings, and citations from this source
              will be permanently removed. This cannot be undone.
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md h-9 px-3.5 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-2 disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              transition:
                "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            autoFocus
            className="inline-flex items-center gap-2 rounded-md h-9 px-3.5 text-sm font-medium border border-danger/30 bg-danger/15 text-danger hover:bg-danger/25 disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              transition:
                "background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
            }}
          >
            {busy ? (
              <>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  className="animate-spin"
                  aria-hidden
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeDasharray="36 20"
                    fill="none"
                  />
                </svg>
                Deleting…
              </>
            ) : (
              "Delete source"
            )}
          </button>
        </div>
      </div>
    </div>
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

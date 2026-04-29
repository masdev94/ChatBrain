"use client";

import { useEffect, useRef, useState } from "react";
import { api, type ChunkNeighbours, type Citation, type SourceType } from "@/lib/api";

// Right-side slide-in drawer that shows the full content of a cited chunk
// plus its immediate neighbours, so users can verify citations in context
// without leaving the chat.
//
// Loading and error states render inline rather than as toasts because the
// drawer is the user's primary focus while it's open — surfacing failures
// here keeps the feedback close to the action.

export interface CitationDrawerProps {
  citation: Citation | null;
  onClose: () => void;
}

export function CitationDrawer({ citation, onClose }: CitationDrawerProps) {
  const [data, setData] = useState<ChunkNeighbours | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Reset render-derived state when the citation identity changes. Using
  // the React-recommended "previous prop" tracker keeps the reset during
  // render (rather than in an effect) so we don't trigger a cascading
  // setState-in-effect cycle. The actual fetch is still kicked off below.
  const citationKey = citation
    ? `${citation.chunk_id ?? ""}::${citation.tag}::${citation.title}`
    : null;
  const [prevCitationKey, setPrevCitationKey] = useState<string | null>(null);
  if (prevCitationKey !== citationKey) {
    setPrevCitationKey(citationKey);
    if (citation) {
      setData(null);
      if (citation.chunk_id) {
        setError(null);
        setLoading(true);
      } else {
        setError(
          "This citation was saved before chunk-level details were available. The snippet is still visible below.",
        );
        setLoading(false);
      }
    }
  }

  // Fetch neighbours whenever the citation changes. The visible loading flag
  // is already on (set during render above) so this effect only resolves it.
  useEffect(() => {
    if (!citation) return;
    const chunkId = citation.chunk_id;
    if (!chunkId) return;

    let cancelled = false;
    api.chunks
      .neighbours(chunkId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || "Couldn't load this chunk.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [citation]);

  // Focus + Escape handling. Mirrors the confirm-delete dialog pattern.
  useEffect(() => {
    if (!citation) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [citation, onClose]);

  if (!citation) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="citation-drawer-title"
      className="fixed inset-0 z-50 flex"
    >
      <button
        type="button"
        aria-label="Close citation drawer"
        onClick={onClose}
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
      />

      <aside
        className="ml-auto h-full w-full max-w-xl surface-elevated border-l border-border flex flex-col"
        style={{
          animation: "slideInRight var(--dur-med) var(--ease-spring) both",
        }}
      >
        <header className="shrink-0 flex items-start gap-3 px-5 py-4 border-b border-border">
          <span
            aria-hidden
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent border border-accent/30 font-mono text-[11.5px] font-semibold"
          >
            {citation.tag}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="citation-drawer-title"
              className="text-[14.5px] font-semibold tracking-tight text-foreground truncate"
              title={citation.title}
            >
              {citation.title}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-[11.5px] text-foreground-subtle">
              <TypeBadge type={citation.type} />
              {data ? (
                <span className="tabular-nums">
                  Chunk {data.current.chunk_index + 1}
                </span>
              ) : null}
              {citation.url ? (
                <>
                  <span aria-hidden>·</span>
                  <a
                    href={citation.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:text-accent-strong truncate max-w-[220px]"
                    style={{
                      transition: "color var(--dur-fast) var(--ease-out)",
                    }}
                  >
                    Open source
                  </a>
                </>
              ) : null}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 grid h-8 w-8 place-items-center rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-2 focus-ring"
            style={{
              transition:
                "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                d="M6 6l12 12M18 6L6 18"
              />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="space-y-2">
              <div className="skeleton h-4 w-3/4" />
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-5/6" />
              <div className="skeleton h-4 w-2/3" />
            </div>
          ) : error ? (
            <ErrorBlock message={error} fallback={citation.snippet} />
          ) : data ? (
            <NeighbourBlocks data={data} />
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function ErrorBlock({
  message,
  fallback,
}: {
  message: string;
  fallback?: string;
}) {
  return (
    <div className="space-y-3">
      <div
        role="alert"
        className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger"
      >
        {message}
      </div>
      {fallback ? (
        <ChunkBlock label="Snippet" content={fallback} />
      ) : null}
    </div>
  );
}

function NeighbourBlocks({ data }: { data: ChunkNeighbours }) {
  return (
    <>
      {data.previous ? (
        <ChunkBlock
          label={`Chunk ${data.previous.chunk_index + 1} (before)`}
          content={data.previous.content}
          dim
        />
      ) : null}
      <ChunkBlock
        label={`Chunk ${data.current.chunk_index + 1}`}
        content={data.current.content}
        highlight
      />
      {data.next ? (
        <ChunkBlock
          label={`Chunk ${data.next.chunk_index + 1} (after)`}
          content={data.next.content}
          dim
        />
      ) : null}
    </>
  );
}

function ChunkBlock({
  label,
  content,
  highlight,
  dim,
}: {
  label: string;
  content: string;
  highlight?: boolean;
  dim?: boolean;
}) {
  const tone = highlight
    ? "border-accent/35 bg-accent/[0.04]"
    : dim
      ? "border-border bg-surface/60 opacity-90"
      : "border-border bg-surface";
  return (
    <section className={`rounded-xl border ${tone} px-4 py-3.5`}>
      <h3 className="mb-1.5 text-[10.5px] uppercase tracking-[0.14em] font-medium text-foreground-subtle">
        {label}
      </h3>
      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground">
        {content}
      </p>
    </section>
  );
}

function TypeBadge({ type }: { type: SourceType }) {
  const dot =
    type === "pdf"
      ? "bg-rose-400"
      : type === "url"
        ? "bg-sky-400"
        : "bg-emerald-400";
  return (
    <span className="inline-flex items-center gap-1.5 capitalize">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {type}
    </span>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  api,
  type Citation,
  type Message,
  type ReasoningEvent,
} from "@/lib/api";

// A streaming assistant message held only in React state until the server
// has finished saving it and we re-fetch. We don't invent an id for it.
interface StreamingMessage {
  role: "assistant";
  content: string;
  reasoning: ReasoningEvent[];
  citations: Citation[];
  streaming: boolean;
  error?: string;
}

type ChatItem =
  | { kind: "stored"; message: Message }
  | { kind: "streaming"; message: StreamingMessage };

export function ChatView({ conversationId }: { conversationId: string }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const msgs = await api.conversations.messages(conversationId);
      setItems(msgs.map((m) => ({ kind: "stored", message: m })));
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof ApiError && e.status === 404
          ? "Conversation not found."
          : e instanceof Error
            ? e.message
            : "Failed to load conversation.",
      );
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  // Reset loading state when the conversation id changes — React's
  // canonical "adjust state on prop change" pattern.
  const [lastLoadedId, setLastLoadedId] = useState(conversationId);
  if (lastLoadedId !== conversationId) {
    setLastLoadedId(conversationId);
    if (!loading) setLoading(true);
    setItems([]);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const msgs = await api.conversations.messages(conversationId);
        if (!cancelled) {
          setItems(msgs.map((m) => ({ kind: "stored", message: m })));
          setLoadError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof ApiError && e.status === 404
              ? "Conversation not found."
              : e instanceof Error
                ? e.message
                : "Failed to load conversation.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const abortCtrl = abortRef.current;
    return () => {
      cancelled = true;
      abortCtrl?.abort();
    };
  }, [conversationId]);

  // Autoscroll on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items]);

  const send = async () => {
    const content = input.trim();
    if (!content || streaming) return;
    setInput("");

    // Optimistically render the user's turn.
    const nowIso = new Date().toISOString();
    const optimisticUser: Message = {
      id: `local-${nowIso}`,
      conversation_id: conversationId,
      role: "user",
      content,
      reasoning: null,
      citations: null,
      created_at: nowIso,
    };
    const streamingMsg: StreamingMessage = {
      role: "assistant",
      content: "",
      reasoning: [],
      citations: [],
      streaming: true,
    };
    setItems((prev) => [
      ...prev,
      { kind: "stored", message: optimisticUser },
      { kind: "streaming", message: streamingMsg },
    ]);

    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const patchStreaming = (patch: (m: StreamingMessage) => StreamingMessage) => {
      setItems((prev) => {
        const out = [...prev];
        for (let i = out.length - 1; i >= 0; i--) {
          const it = out[i];
          if (it.kind === "streaming") {
            out[i] = { kind: "streaming", message: patch(it.message) };
            break;
          }
        }
        return out;
      });
    };

    try {
      for await (const event of api.chat.stream(
        conversationId,
        content,
        controller.signal,
      )) {
        const t = event.type as string;
        if (t === "thinking") {
          patchStreaming((m) => ({
            ...m,
            reasoning: [
              ...m.reasoning,
              { type: "thinking", text: String(event.text ?? "") },
            ],
          }));
        } else if (t === "sources_considered") {
          patchStreaming((m) => ({
            ...m,
            reasoning: [
              ...m.reasoning,
              {
                type: "sources_considered",
                sources: (event.sources ?? []) as ReasoningEvent["sources"],
              },
            ],
          }));
        } else if (t === "token") {
          patchStreaming((m) => ({
            ...m,
            content: m.content + String(event.text ?? ""),
          }));
        } else if (t === "citations") {
          patchStreaming((m) => ({
            ...m,
            citations: (event.citations ?? []) as Citation[],
          }));
        } else if (t === "done") {
          patchStreaming((m) => ({ ...m, streaming: false }));
        } else if (t === "error") {
          patchStreaming((m) => ({
            ...m,
            streaming: false,
            error: String(event.message ?? "Something went wrong."),
          }));
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patchStreaming((m) => ({
          ...m,
          streaming: false,
          error: e instanceof Error ? e.message : "Network error.",
        }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Pull the durable record from the server so the UI matches what's saved
      // (and to swap the local id for the real uuid).
      refresh();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const empty = !loading && items.length === 0 && !loadError;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {loadError ? (
        <div className="p-4">
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {loadError}
          </div>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl px-4 md:px-6 py-6 space-y-6">
          {empty ? <ChatEmpty /> : null}
          {items.map((it, i) =>
            it.kind === "stored" ? (
              <StoredMessage key={it.message.id} message={it.message} />
            ) : (
              <AssistantStream key={`s-${i}`} message={it.message} />
            ),
          )}
        </div>
      </div>

      <div className="border-t border-border bg-background/80 backdrop-blur px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-xl border border-border bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30 transition">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask anything about your knowledge base…"
              className="flex-1 resize-none bg-transparent px-3 py-3 text-sm focus:outline-none max-h-48"
            />
            {streaming ? (
              <button
                onClick={() => abortRef.current?.abort()}
                className="m-1.5 rounded-md bg-surface-2 hover:bg-border text-foreground-muted hover:text-foreground px-3 py-2 text-sm transition"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim()}
                className="m-1.5 rounded-md bg-accent hover:bg-accent-strong text-[#0b0d12] font-medium px-3 py-2 text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Send
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-foreground-muted text-center">
            Answers are grounded in your knowledge base. Enter sends,
            Shift+Enter for newline.
          </p>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Renderers
// ──────────────────────────────────────────────────────────────────────────
function StoredMessage({ message }: { message: Message }) {
  if (message.role === "user") {
    return <UserBubble content={message.content} />;
  }
  return (
    <AssistantBubble
      content={message.content}
      reasoning={message.reasoning ?? []}
      citations={message.citations ?? []}
      streaming={false}
    />
  );
}

function AssistantStream({ message }: { message: StreamingMessage }) {
  return (
    <AssistantBubble
      content={message.content}
      reasoning={message.reasoning}
      citations={message.citations}
      streaming={message.streaming}
      error={message.error}
    />
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent/90 text-[#0b0d12] px-4 py-2.5 text-sm whitespace-pre-wrap">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({
  content,
  reasoning,
  citations,
  streaming,
  error,
}: {
  content: string;
  reasoning: ReasoningEvent[];
  citations: Citation[];
  streaming: boolean;
  error?: string;
}) {
  return (
    <div className="flex">
      <div className="max-w-full w-full">
        {reasoning.length > 0 || streaming ? (
          <ThinkingPanel reasoning={reasoning} streaming={streaming} />
        ) : null}
        {error ? (
          <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        {content ? (
          <div className="mt-2 rounded-2xl border border-border bg-surface px-4 py-3 text-[15px] leading-relaxed">
            <AnswerText content={content} streaming={streaming} />
          </div>
        ) : streaming ? (
          <div className="mt-2 rounded-2xl border border-border bg-surface px-4 py-3">
            <span className="stream-caret text-foreground-muted text-sm">Composing answer</span>
          </div>
        ) : null}
        {citations.length > 0 ? <CitationsBar citations={citations} /> : null}
      </div>
    </div>
  );
}

/**
 * Renders a thinking trace as a collapsible panel above the answer. Each
 * thinking event is a line; sources_considered becomes a mini table of chips.
 */
function ThinkingPanel({
  reasoning,
  streaming,
}: {
  reasoning: ReasoningEvent[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-2xl border border-border bg-surface/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-foreground-muted hover:text-foreground transition"
      >
        <span className="inline-flex h-5 w-5 items-center justify-center">
          {streaming ? (
            <svg
              viewBox="0 0 24 24"
              className="animate-spin h-4 w-4 text-accent"
              aria-hidden
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="36 20" fill="none" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-success" aria-hidden>
              <path fill="currentColor" d="M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z" />
            </svg>
          )}
        </span>
        <span className="font-medium">
          {streaming ? "Thinking" : "Thought process"}
        </span>
        <span className="ml-auto text-xs">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open ? (
        <div className="px-4 pb-3 space-y-2 text-sm">
          {reasoning.map((r, i) =>
            r.type === "thinking" ? (
              <div key={i} className="flex gap-2 text-foreground-muted">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
                <span>{r.text}</span>
              </div>
            ) : r.type === "sources_considered" && r.sources?.length ? (
              <div key={i} className="pl-3.5">
                <div className="text-xs text-foreground-muted mb-1.5">
                  Sources considered
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.sources.map((s) => (
                    <span
                      key={s.source_id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px]"
                      title={`${s.chunk_count} chunk${s.chunk_count !== 1 ? "s" : ""} · ${Math.round(s.top_similarity * 100)}% match`}
                    >
                      <TypeDot type={s.type} />
                      <span className="truncate max-w-[16rem]">{s.title}</span>
                      <span className="text-foreground-muted">
                        {Math.round(s.top_similarity * 100)}%
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function TypeDot({ type }: { type: "pdf" | "text" | "url" }) {
  const color =
    type === "pdf"
      ? "bg-rose-400"
      : type === "url"
        ? "bg-sky-400"
        : "bg-emerald-400";
  return <span className={`h-1.5 w-1.5 rounded-full ${color}`} />;
}

/**
 * Renders the answer with inline [Sn] tags turned into small citation pills.
 * Keeps the transformation pure-text: no markdown dependency.
 */
function AnswerText({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const parts = useMemo(() => splitWithCitations(content), [content]);
  return (
    <div className="whitespace-pre-wrap">
      {parts.map((p, i) =>
        p.type === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span
            key={i}
            className="mx-0.5 inline-flex items-center rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent align-[1px]"
            title={`Source ${p.n}`}
          >
            S{p.n}
          </span>
        ),
      )}
      {streaming ? <span className="stream-caret" /> : null}
    </div>
  );
}

function splitWithCitations(content: string): (
  | { type: "text"; text: string }
  | { type: "cite"; n: number }
)[] {
  const out: (
    | { type: "text"; text: string }
    | { type: "cite"; n: number }
  )[] = [];
  const re = /\[S(\d+)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last)
      out.push({ type: "text", text: content.slice(last, m.index) });
    out.push({ type: "cite", n: parseInt(m[1], 10) });
    last = m.index + m[0].length;
  }
  if (last < content.length)
    out.push({ type: "text", text: content.slice(last) });
  return out;
}

function CitationsBar({ citations }: { citations: Citation[] }) {
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {citations.map((c) => {
        const body = (
          <>
            <TypeDot type={c.type} />
            <span className="font-medium text-[11px] text-accent">{c.tag}</span>
            <span className="truncate max-w-[18rem]">{c.title}</span>
          </>
        );
        const className =
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs hover:border-border-strong hover:bg-surface-2 transition";
        return c.url ? (
          <a
            key={`${c.source_id}-${c.tag}`}
            href={c.url}
            target="_blank"
            rel="noreferrer"
            className={className}
            title={c.snippet}
          >
            {body}
          </a>
        ) : (
          <span
            key={`${c.source_id}-${c.tag}`}
            className={className}
            title={c.snippet}
          >
            {body}
          </span>
        );
      })}
    </div>
  );
}

function ChatEmpty() {
  return (
    <div className="grid place-items-center py-16">
      <div className="text-center">
        <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
            <path
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2H9l-5 4V6z"
            />
          </svg>
        </div>
        <h2 className="text-lg font-medium">Ask your knowledge base</h2>
        <p className="mt-1 text-sm text-foreground-muted max-w-sm">
          ChatBrain pulls from every source you&apos;ve added, shows its
          reasoning, and cites where each answer came from.
        </p>
      </div>
    </div>
  );
}

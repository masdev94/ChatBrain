"use client";

import {
  Children,
  Fragment,
  isValidElement,
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ApiError,
  api,
  type Citation,
  type Message,
  type ReasoningEvent,
} from "@/lib/api";
import { useToast } from "@/components/toast";
import { CitationDrawer } from "@/components/citation-drawer";

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

// Threshold (px) for "is the user near the bottom?". Below this we consider
// the conversation pinned and autoscroll on new content; above it we hide
// the autoscroll behaviour and surface the floating Jump button instead so
// the user can read older messages without being yanked away.
const NEAR_BOTTOM_PX = 120;
// Distance (px) from bottom at which the floating Jump button appears.
const SHOW_JUMP_PX = 200;

export function ChatView({ conversationId }: { conversationId: string }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // True when the user has scrolled up far enough that we should stop
  // pinning to the bottom on new tokens. Reset by Jump-to-latest or by
  // the user scrolling back near the bottom themselves.
  const [pinned, setPinned] = useState(true);
  // True when the user is far enough from the bottom that we should show
  // the Jump button (≥ SHOW_JUMP_PX). Slightly looser than `!pinned` so the
  // button doesn't flicker right at the threshold.
  const [showJump, setShowJump] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { toast } = useToast();
  // Citation the user clicked. The drawer reads chunk + neighbours from
  // the backend on its own; we only own the open/close state here.
  const [openCitation, setOpenCitation] = useState<Citation | null>(null);

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

  // Autoscroll on new content — but only when the user is "pinned" near
  // the bottom. If they've scrolled up to read older messages we leave
  // their position alone and surface the Jump button instead.
  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items, pinned]);

  // Track scroll position. Drives both the pinned/unpinned autoscroll
  // toggle and the visibility of the floating Jump button.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(distance <= NEAR_BOTTOM_PX);
      setShowJump(distance >= SHOW_JUMP_PX);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Reset to pinned whenever the conversation changes — the new view should
  // start at the bottom, not preserve scroll from the previous chat. Uses
  // the React-recommended "previous prop" tracker so the reset is part of
  // render rather than a cascading setState-in-effect.
  const [prevConversationId, setPrevConversationId] = useState(conversationId);
  if (prevConversationId !== conversationId) {
    setPrevConversationId(conversationId);
    setPinned(true);
    setShowJump(false);
  }
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinned(true);
  }, []);

  const send = async () => {
    const content = input.trim();
    if (!content || streaming) return;
    setInput("");
    // Sending always means the user wants to see the response — re-pin
    // even if they had scrolled up earlier.
    setPinned(true);

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

      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 md:px-6 py-8 space-y-6">
          {empty ? <ChatEmpty onPick={(q) => setInput(q)} /> : null}
          {items.map((it, i) =>
            it.kind === "stored" ? (
              <StoredMessage
                key={it.message.id}
                message={it.message}
                onCopy={(text) => copyAnswer(text, toast)}
                onOpenCitation={setOpenCitation}
              />
            ) : (
              <AssistantStream
                key={`s-${i}`}
                message={it.message}
                onCopy={(text) => copyAnswer(text, toast)}
                onOpenCitation={setOpenCitation}
              />
            ),
          )}
        </div>
        {showJump ? (
          <JumpToLatestButton
            onClick={jumpToBottom}
            highlight={streaming && !pinned}
          />
        ) : null}
      </div>

      <CitationDrawer
        citation={openCitation}
        onClose={() => setOpenCitation(null)}
      />

      {/* Composer — single layered surface with primary-ring focus glow. */}
      <div className="border-t border-border bg-[color-mix(in_oklab,var(--bg-primary)_82%,transparent)] backdrop-blur-md px-4 py-3.5">
        <div className="mx-auto max-w-3xl">
          <div
            className="group flex items-end gap-2 rounded-xl border border-border bg-surface shadow-sm focus-within:border-accent/70"
            style={{
              transition:
                "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask anything about your knowledge base…"
              className="flex-1 resize-none bg-transparent px-4 py-3 text-[15px] leading-relaxed focus:outline-none max-h-48 placeholder:text-foreground-subtle"
            />
            {streaming ? (
              <button
                onClick={() => abortRef.current?.abort()}
                className="m-1.5 inline-flex items-center gap-1.5 rounded-md bg-surface-2 hover:bg-border text-foreground-muted hover:text-foreground px-3 h-9 text-sm"
                style={{
                  transition:
                    "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
                Stop
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim()}
                aria-label="Send message"
                className="m-1.5 inline-flex items-center gap-1.5 rounded-md bg-accent hover:bg-accent-strong text-[#0b0d12] font-medium px-3.5 h-9 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  transition:
                    "background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)",
                }}
              >
                Send
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 12h14M13 6l6 6-6 6"
                  />
                </svg>
              </button>
            )}
          </div>
          <p className="mt-2 text-[11.5px] text-foreground-subtle text-center">
            Grounded in your sources.{" "}
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-2 text-[10.5px] font-mono text-foreground-muted">
              Enter
            </kbd>{" "}
            to send,{" "}
            <kbd className="px-1 py-0.5 rounded border border-border bg-surface-2 text-[10.5px] font-mono text-foreground-muted">
              Shift+Enter
            </kbd>{" "}
            for newline.
          </p>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Renderers
// ──────────────────────────────────────────────────────────────────────────
function StoredMessage({
  message,
  onCopy,
  onOpenCitation,
}: {
  message: Message;
  onCopy: (text: string) => void;
  onOpenCitation: (c: Citation) => void;
}) {
  if (message.role === "user") {
    return <UserBubble content={message.content} />;
  }
  return (
    <AssistantBubble
      content={message.content}
      reasoning={message.reasoning ?? []}
      citations={message.citations ?? []}
      streaming={false}
      onCopy={onCopy}
      onOpenCitation={onOpenCitation}
    />
  );
}

function AssistantStream({
  message,
  onCopy,
  onOpenCitation,
}: {
  message: StreamingMessage;
  onCopy: (text: string) => void;
  onOpenCitation: (c: Citation) => void;
}) {
  return (
    <AssistantBubble
      content={message.content}
      reasoning={message.reasoning}
      citations={message.citations}
      streaming={message.streaming}
      error={message.error}
      onCopy={onCopy}
      onOpenCitation={onOpenCitation}
    />
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent text-[#0b0d12] px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap shadow-sm">
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
  onCopy,
  onOpenCitation,
}: {
  content: string;
  reasoning: ReasoningEvent[];
  citations: Citation[];
  streaming: boolean;
  error?: string;
  onCopy: (text: string) => void;
  onOpenCitation: (c: Citation) => void;
}) {
  // Show the Copy affordance only on finished, non-empty answers — copying
  // a partial mid-stream answer is rarely what the user wants.
  const canCopy = !streaming && content.trim().length > 0;
  return (
    <div className="flex gap-3">
      {/* Avatar rail — a small amber dot doubles as "this is the assistant"
          and echoes the streaming-caret color language. */}
      <div aria-hidden className="shrink-0 pt-1.5">
        <span className="inline-block h-7 w-7 rounded-full border border-border bg-surface grid place-items-center">
          <span className="h-2 w-2 rounded-full bg-spark" />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        {reasoning.length > 0 || streaming ? (
          <ThinkingPanel reasoning={reasoning} streaming={streaming} />
        ) : null}
        {error ? (
          <div
            role="alert"
            className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {error}
          </div>
        ) : null}
        {content ? (
          <div className="group relative mt-2.5 rounded-2xl rounded-tl-md border border-border bg-surface px-5 py-4 shadow-sm">
            <AnswerText
              content={content}
              streaming={streaming}
              citations={citations}
              onOpenCitation={onOpenCitation}
            />
            {canCopy ? (
              <CopyAnswerButton onClick={() => onCopy(content)} />
            ) : null}
          </div>
        ) : streaming ? (
          <div className="mt-2.5 rounded-2xl rounded-tl-md border border-border bg-surface px-5 py-4">
            <span className="stream-caret text-foreground-muted text-sm">
              Composing answer
            </span>
          </div>
        ) : null}
        {citations.length > 0 ? (
          <CitationsBar
            citations={citations}
            onOpenCitation={onOpenCitation}
          />
        ) : null}
      </div>
    </div>
  );
}

function CopyAnswerButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Copy answer"
      title="Copy answer"
      className="absolute right-2.5 bottom-2.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle hover:text-foreground hover:bg-surface-2 opacity-0 group-hover:opacity-100 focus:opacity-100 focus-ring"
      style={{
        transition:
          "opacity var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect
          x="9"
          y="9"
          width="11"
          height="11"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5 15V6a2 2 0 012-2h9"
        />
      </svg>
    </button>
  );
}

function JumpToLatestButton({
  onClick,
  highlight,
}: {
  onClick: () => void;
  highlight: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 rounded-full px-3.5 h-8 text-[12.5px] font-medium border shadow-md focus-ring ${
        highlight
          ? "bg-accent text-[#0b0d12] border-accent hover:bg-accent-strong"
          : "bg-surface text-foreground-muted border-border hover:bg-surface-2 hover:text-foreground"
      }`}
      style={{
        animation: "fadeUp var(--dur-fast) var(--ease-spring) both",
        transition:
          "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
      }}
      aria-label="Jump to latest message"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6 9l6 6 6-6"
        />
      </svg>
      {highlight ? "New messages" : "Jump to latest"}
    </button>
  );
}

// Helper extracted from JSX so callers don't have to repeat the toast
// boilerplate. The clipboard API can throw on insecure contexts (file://,
// some embedded views) so we surface a useful error toast instead of
// silently failing.
function copyAnswer(text: string, toast: ReturnType<typeof useToast>["toast"]) {
  if (!navigator.clipboard) {
    toast({
      variant: "error",
      title: "Couldn't copy",
      description: "Clipboard isn't available in this context.",
    });
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => {
      toast({ variant: "success", description: "Answer copied to clipboard." });
    })
    .catch(() => {
      toast({
        variant: "error",
        title: "Couldn't copy",
        description: "Your browser blocked clipboard access.",
      });
    });
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
    <div className="rounded-2xl rounded-tl-md border border-border bg-surface/50">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground-muted hover:text-foreground"
        style={{
          transition:
            "color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)",
        }}
      >
        <span className="inline-flex h-5 w-5 items-center justify-center">
          {streaming ? (
            <svg
              viewBox="0 0 24 24"
              className="animate-spin h-4 w-4 text-spark"
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
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-success" aria-hidden>
              <path
                fill="currentColor"
                d="M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z"
              />
            </svg>
          )}
        </span>
        <span className="font-medium text-foreground tracking-tight">
          {streaming ? "Thinking" : "Thought process"}
        </span>
        {reasoning.length > 0 ? (
          <span className="text-[11px] text-foreground-subtle tabular-nums">
            {reasoning.filter((r) => r.type === "thinking").length} steps
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-foreground-subtle">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open ? (
        <div className="px-4 pb-3.5 pt-1 space-y-2.5 text-[13.5px] border-t border-border/60">
          {reasoning.map((r, i) =>
            r.type === "thinking" ? (
              <div key={i} className="flex gap-2.5 text-foreground-muted pt-2">
                <span
                  aria-hidden
                  className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-spark/80"
                />
                <span className="leading-relaxed">{r.text}</span>
              </div>
            ) : r.type === "sources_considered" && r.sources?.length ? (
              <div key={i} className="pl-4 pt-1">
                <div className="text-[10.5px] uppercase tracking-wider text-foreground-subtle font-medium mb-1.5">
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
                      <span className="text-foreground-subtle tabular-nums">
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
 * Renders the assistant answer as markdown (headings, bold, bullet lists,
 * code, tables, …) and turns inline [Sn] tags into small citation pills. We
 * walk the markdown output tree and substitute [Sn] at text leaves so the
 * pills render inside paragraphs, list items, headings — wherever the model
 * places them.
 */
function AnswerText({
  content,
  streaming,
  citations,
  onOpenCitation,
}: {
  content: string;
  streaming: boolean;
  citations: Citation[];
  onOpenCitation: (c: Citation) => void;
}) {
  // Index citations by their tag (e.g. "S1") so the inline pill lookup is
  // O(1) regardless of citation count.
  const byTag: Record<string, Citation> = {};
  for (const c of citations) byTag[c.tag] = c;

  const render = (children: ReactNode) =>
    renderWithCitations(children, byTag, onOpenCitation);

  return (
    <div className="answer-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{render(children)}</p>,
          li: ({ children }) => <li>{render(children)}</li>,
          h1: ({ children }) => <h1>{render(children)}</h1>,
          h2: ({ children }) => <h2>{render(children)}</h2>,
          h3: ({ children }) => <h3>{render(children)}</h3>,
          h4: ({ children }) => <h4>{render(children)}</h4>,
          strong: ({ children }) => <strong>{render(children)}</strong>,
          em: ({ children }) => <em>{render(children)}</em>,
          td: ({ children }) => <td>{render(children)}</td>,
          th: ({ children }) => <th>{render(children)}</th>,
          blockquote: ({ children }) => (
            <blockquote>{render(children)}</blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {render(children)}
            </a>
          ),
          pre: ({ children }) => <pre>{children}</pre>,
          code: ({ children, ...rest }) => <code {...rest}>{children}</code>,
        }}
      >
        {content}
      </ReactMarkdown>
      {streaming ? <span className="stream-caret" /> : null}
    </div>
  );
}

const CITATION_RE = /\[S(\d+)\]/g;

function CitationPill({
  n,
  citation,
  onOpen,
}: {
  n: number;
  citation?: Citation;
  onOpen: (c: Citation) => void;
}) {
  const baseClass =
    "mx-0.5 inline-flex items-center rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent align-[1px]";
  const label = `S${n}`;

  if (!citation) {
    return (
      <span className={baseClass} title={`Source ${n}`}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(citation)}
      title={citation.title}
      aria-label={`Open citation ${label}: ${citation.title}`}
      className={`${baseClass} hover:bg-accent/20 hover:border-accent/70 focus-ring cursor-pointer`}
      style={{
        transition:
          "background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

/**
 * Recursively walks React children produced by react-markdown and replaces
 * [Sn] tokens inside string leaves with CitationPill components. Non-string
 * nodes (e.g. nested <strong>, <code>) are descended into so citations work
 * even when wrapped in inline formatting.
 */
function renderWithCitations(
  children: ReactNode,
  byTag: Record<string, Citation>,
  onOpen: (c: Citation) => void,
): ReactNode {
  const out: ReactNode[] = [];
  let key = 0;
  Children.forEach(children, (child) => {
    if (typeof child === "string") {
      out.push(...splitCitationString(child, () => key++, byTag, onOpen));
      return;
    }
    if (typeof child === "number" || typeof child === "boolean") {
      out.push(child);
      return;
    }
    if (child == null) return;
    if (isValidElement(child)) {
      const el = child as React.ReactElement<{ children?: ReactNode }>;
      const nested = el.props?.children;
      if (nested !== undefined) {
        out.push(
          cloneElement(
            el,
            { key: key++ },
            renderWithCitations(nested, byTag, onOpen),
          ),
        );
      } else {
        out.push(cloneElement(el, { key: key++ }));
      }
      return;
    }
    out.push(child);
  });
  return out;
}

function splitCitationString(
  text: string,
  nextKey: () => number,
  byTag: Record<string, Citation>,
  onOpen: (c: Citation) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push(
        <Fragment key={nextKey()}>{text.slice(last, m.index)}</Fragment>,
      );
    }
    const n = parseInt(m[1], 10);
    out.push(
      <CitationPill
        key={nextKey()}
        n={n}
        citation={byTag[`S${n}`]}
        onOpen={onOpen}
      />,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(<Fragment key={nextKey()}>{text.slice(last)}</Fragment>);
  }
  return out;
}

function CitationsBar({
  citations,
  onOpenCitation,
}: {
  citations: Citation[];
  onOpenCitation: (c: Citation) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {citations.map((c) => (
        <button
          type="button"
          key={`${c.source_id}-${c.tag}`}
          onClick={() => onOpenCitation(c)}
          title={c.snippet}
          aria-label={`Open citation ${c.tag}: ${c.title}`}
          className="group inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs hover:border-border-strong hover:bg-surface-2 focus-ring text-left"
          style={{
            transition:
              "background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          }}
        >
          <TypeDot type={c.type} />
          <span className="font-mono text-[10.5px] font-semibold text-accent">
            {c.tag}
          </span>
          <span className="truncate max-w-[18rem] text-foreground-muted group-hover:text-foreground">
            {c.title}
          </span>
        </button>
      ))}
    </div>
  );
}

const SUGGESTED_PROMPTS = [
  "Summarize the key points across my sources.",
  "What are the main disagreements between my documents?",
  "Give me a chronological outline of the main events.",
];

function ChatEmpty({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-border bg-surface/40 px-6 md:px-10 py-14 md:py-20">
      <div aria-hidden className="absolute inset-0 dot-grid opacity-40 [mask-image:radial-gradient(ellipse_at_top,black,transparent_75%)]" />
      <span aria-hidden className="orb orb--small orb--amber -top-10 -right-10" />
      <div className="relative fade-up text-center max-w-2xl mx-auto">
        <div className="mx-auto mb-5 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent border border-accent/25">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
            <path
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2H9l-5 4V6z"
            />
          </svg>
        </div>
        <h2 className="text-2xl md:text-3xl font-bold tracking-[-0.02em] text-foreground">
          Ask your second brain.
        </h2>
        <p className="mt-2 text-[14.5px] text-foreground-muted max-w-lg mx-auto leading-relaxed">
          ChatBrain pulls from every source you&rsquo;ve added, shows its
          reasoning step by step, and cites where each claim came from.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => onPick(p)}
              className="rounded-full border border-border bg-surface hover:border-border-strong hover:bg-surface-2 text-[13px] text-foreground-muted hover:text-foreground px-3.5 py-1.5"
              style={{
                transition:
                  "background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ───────────────────────────────────────────────────────────────────────────
// Toast: a small global notification stack. Used for delete success/failure,
// copy-to-clipboard confirmation, smart-paste hints, and any error that
// shouldn't crash the page or block the user with a modal.
// ───────────────────────────────────────────────────────────────────────────

export type ToastVariant = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title?: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
  action?: ToastAction;
}

interface ToastEntry extends Required<Omit<ToastOptions, "action" | "title" | "description">> {
  id: number;
  title?: string;
  description?: string;
  action?: ToastAction;
}

interface ToastContextValue {
  toast: (opts: ToastOptions | string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (opts: ToastOptions | string): number => {
      idRef.current += 1;
      const id = idRef.current;
      const normalized: ToastOptions =
        typeof opts === "string" ? { description: opts } : opts;
      const entry: ToastEntry = {
        id,
        title: normalized.title,
        description: normalized.description,
        variant: normalized.variant ?? "info",
        durationMs: normalized.durationMs ?? DEFAULT_DURATION_MS,
        action: normalized.action,
      };
      setEntries((prev) => [...prev, entry]);

      if (entry.durationMs > 0) {
        const t = setTimeout(() => dismiss(id), entry.durationMs);
        timersRef.current.set(id, t);
      }
      return id;
    },
    [dismiss],
  );

  // Clean up any pending timers on unmount so we don't leak.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toast, dismiss }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport entries={entries} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return ctx;
}

// ───────────────────────────────────────────────────────────────────────────
// Viewport — the actual rendered stack. Top-right, slides in from above.
// ───────────────────────────────────────────────────────────────────────────

function ToastViewport({
  entries,
  onDismiss,
}: {
  entries: ToastEntry[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed top-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {entries.map((e) => (
        <ToastItem key={e.id} entry={e} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: (id: number) => void;
}) {
  const tone = TONES[entry.variant];
  return (
    <div
      role={entry.variant === "error" ? "alert" : "status"}
      className={`pointer-events-auto fade-up surface-elevated rounded-xl px-3.5 py-3 text-[13px] shadow-lg ${tone.ring}`}
      style={{ animation: "fadeUp var(--dur-med) var(--ease-spring) both" }}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${tone.iconBg} ${tone.iconText}`}
        >
          {tone.icon}
        </span>
        <div className="min-w-0 flex-1">
          {entry.title ? (
            <p className="font-medium text-foreground leading-tight">{entry.title}</p>
          ) : null}
          {entry.description ? (
            <p className={`${entry.title ? "mt-0.5" : ""} text-foreground-muted leading-snug`}>
              {entry.description}
            </p>
          ) : null}
          {entry.action ? (
            <button
              type="button"
              onClick={() => {
                entry.action?.onClick();
                onDismiss(entry.id);
              }}
              className="mt-1.5 text-[12.5px] font-medium text-accent hover:text-accent-strong"
              style={{ transition: "color var(--dur-fast) var(--ease-out)" }}
            >
              {entry.action.label}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(entry.id)}
          aria-label="Dismiss"
          className="shrink-0 grid h-5 w-5 place-items-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-2"
          style={{
            transition:
              "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              d="M6 6l12 12M18 6L6 18"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

const TONES: Record<
  ToastVariant,
  { ring: string; iconBg: string; iconText: string; icon: React.ReactNode }
> = {
  success: {
    ring: "ring-1 ring-success/30",
    iconBg: "bg-success/15",
    iconText: "text-success",
    icon: (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5 12l5 5L20 7"
        />
      </svg>
    ),
  },
  error: {
    ring: "ring-1 ring-danger/35",
    iconBg: "bg-danger/15",
    iconText: "text-danger",
    icon: (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 8v5m0 3.5h.01"
        />
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  },
  info: {
    ring: "ring-1 ring-accent/30",
    iconBg: "bg-accent/15",
    iconText: "text-accent",
    icon: (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          d="M12 8v.01M11 12h1v5h1"
        />
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  },
};

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "@/components/brand";
import { signOutAction } from "@/app/auth/actions";
import { api, type Conversation } from "@/lib/api";
import { useToast } from "@/components/toast";

export function AppShell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Desktop sidebar collapsed state. Persisted to localStorage so it
  // survives page reloads — real products remember layout preferences.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("sidebar-collapsed") === "1";
  });
  // Which conversation (if any) has the delete confirmation modal open.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Tracks the in-flight delete so the modal's Delete button can show a busy
  // state and both modal buttons disable while the request runs.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Sidebar conversation filter — purely client-side substring match.
  const [convFilter, setConvFilter] = useState("");
  // Inline-rename state for the conversation the user is currently editing.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    localStorage.setItem("sidebar-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  const confirmingConversation = confirmingId
    ? conversations.find((c) => c.id === confirmingId) ?? null
    : null;

  // Re-fetch the sidebar list whenever the route changes (so a newly created
  // conversation appears, a renamed one updates, etc.).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.conversations.list();
        if (!cancelled) setConversations(list);
      } catch {
        /* surfaces on the page itself */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Close the drawer — and clear any half-armed delete confirmation — when the
  // user navigates. Previous path lives in state (rather than an effect or a
  // ref write during render) to satisfy React 19's stricter rules.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (mobileOpen) setMobileOpen(false);
    if (confirmingId) setConfirmingId(null);
  }

  const newChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const conv = await api.conversations.create();
      setConversations((prev) => [conv, ...prev]);
      router.push(`/app/chat/${conv.id}`);
    } finally {
      setCreating(false);
    }
  };

  // Delete a conversation. Optimistically removes the row, rolls back on
  // failure. If the user is currently viewing the deleted conversation we
  // send them back to the app root (which redirects to /app/sources).
  const deleteConversation = async (id: string) => {
    if (deletingId) return;
    const snapshot = conversations;
    const removed = conversations.find((c) => c.id === id);
    setDeletingId(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      await api.conversations.remove(id);
      setConfirmingId(null);
      if (pathname === `/app/chat/${id}`) {
        router.push("/app");
      }
      toast({
        variant: "success",
        description: removed
          ? `Deleted "${removed.title}".`
          : "Conversation deleted.",
      });
    } catch (err) {
      // Restore the list so the user doesn't silently lose their row.
      setConversations(snapshot);
      toast({
        variant: "error",
        title: "Couldn't delete conversation",
        description:
          err instanceof Error ? err.message : "Please try again in a moment.",
      });
    } finally {
      setDeletingId(null);
    }
  };

  // Inline rename. Optimistic — the row updates immediately and rolls back
  // with a toast if the PATCH fails.
  const renameConversation = async (id: string, nextTitle: string) => {
    const trimmed = nextTitle.trim();
    const snapshot = conversations;
    const current = conversations.find((c) => c.id === id);
    if (!current || !trimmed || trimmed === current.title) {
      setRenamingId(null);
      return;
    }
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
    );
    setRenamingId(null);
    try {
      const updated = await api.conversations.rename(id, trimmed);
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...updated } : c)),
      );
    } catch (err) {
      setConversations(snapshot);
      toast({
        variant: "error",
        title: "Couldn't rename",
        description:
          err instanceof Error ? err.message : "The change was rolled back.",
      });
    }
  };

  const conversationCount = conversations.length;
  // Match against the visible title with a case-insensitive substring.
  const filteredConversations = useMemo(() => {
    const q = convFilter.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, convFilter]);

  return (
    // h-screen (and h-dvh on mobile) constrains the whole shell to the
    // viewport so pages can own their own internal scroll containers —
    // chat scrolls its messages, sources scrolls its list, the composer
    // stays pinned. overflow-hidden on the shell prevents any child from
    // growing the page.
    <div className="h-dvh flex bg-background overflow-hidden">
      {/* Mobile top bar. Hidden on md+, where the sidebar is always visible. */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 flex items-center justify-between px-4 h-14 border-b border-border bg-[color-mix(in_oklab,var(--surface)_88%,transparent)] backdrop-blur-md">
        <BrandMark size={22} />
        <button
          aria-label="Toggle sidebar"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="rounded-md p-2 text-foreground-muted hover:text-foreground hover:bg-surface-2"
          style={{
            transition:
              "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
      </header>

      <aside
        aria-label="Primary"
        className={`fixed md:static inset-y-0 left-0 z-40 shrink-0 border-r border-border flex flex-col md:translate-x-0 ${
          collapsed ? "md:w-[68px]" : "w-72"
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full"} ${
          !mobileOpen && !collapsed ? "w-72" : ""
        }`}
        style={{
          transition: "transform var(--dur-med) var(--ease-out), width var(--dur-med) var(--ease-out)",
          background:
            "linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, transparent) 0%, color-mix(in oklab, var(--surface) 92%, var(--bg-primary)) 100%)",
        }}
      >
        {/* Sidebar header — brand + collapse toggle */}
        <div className="h-14 flex items-center justify-between px-3 border-b border-border/70">
          <Link
            href="/app"
            className="flex items-center gap-2 focus-ring rounded-md px-1.5 py-1 hover:bg-surface-2/60"
            style={{
              transition: "background-color var(--dur-fast) var(--ease-out)",
            }}
          >
            <BrandMark size={22} showWordmark={!collapsed} />
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden md:grid h-7 w-7 place-items-center rounded-md text-foreground-subtle hover:text-foreground hover:bg-surface-2 shrink-0"
            style={{
              transition:
                "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
              style={{
                transform: collapsed ? "rotate(180deg)" : "none",
                transition: "transform var(--dur-med) var(--ease-out)",
              }}
            >
              <path
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M11 19l-7-7 7-7M18 19l-7-7 7-7"
              />
            </svg>
          </button>
        </div>

        {/* Primary actions */}
        <div className={`px-3 pt-3 pb-2 space-y-1 ${collapsed ? "px-2" : ""}`}>
          <button
            onClick={newChat}
            disabled={creating}
            title={collapsed ? "New chat" : undefined}
            className={`btn-press group relative w-full inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-[#0b0d12] font-medium text-[13.5px] tracking-tight disabled:opacity-60 hover:bg-accent-strong overflow-hidden ${
              collapsed ? "h-10 w-10 p-0" : "py-2.5"
            }`}
            style={{
              transition:
                "background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
              boxShadow:
                "0 1px 0 color-mix(in oklab, white 18%, transparent) inset, 0 1px 2px rgba(0,0,0,0.25)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                d="M12 5v14M5 12h14"
              />
            </svg>
            {collapsed ? null : creating ? "Creating…" : "New chat"}
          </button>

          <NavItem
            href="/app/sources"
            active={pathname === "/app/sources"}
            collapsed={collapsed}
            icon={
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <path
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 6a2 2 0 012-2h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"
                />
                <path
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  d="M14 4v5h5"
                />
              </svg>
            }
            label="Knowledge base"
          />
        </div>

        {/* Conversations section — hidden when sidebar is collapsed */}
        {collapsed ? null : (
          <div className="mt-2 px-5 pt-3 pb-1.5 flex items-center justify-between">
            <span className="text-[10.5px] uppercase tracking-[0.14em] font-medium text-foreground-subtle">
              Conversations
            </span>
            {conversationCount > 0 ? (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-surface-2 text-[10.5px] font-medium text-foreground-muted tabular-nums">
                {conversationCount}
              </span>
            ) : null}
          </div>
        )}

        {/* Filter — only useful when the list is long enough that scanning
            by eye gets slow. Hidden under 6 entries to keep the sidebar
            quiet. */}
        {!collapsed && conversationCount > 5 ? (
          <div className="px-3 pb-2">
            <ConversationFilterInput
              value={convFilter}
              onChange={setConvFilter}
            />
          </div>
        ) : null}

        <nav
          aria-label="Conversations"
          className={`flex-1 overflow-y-auto pb-4 ${collapsed ? "px-1" : "px-2"}`}
        >
          {collapsed ? null : loading ? (
            <div className="space-y-1.5 px-2 pt-1">
              <div className="skeleton h-8 w-full" />
              <div className="skeleton h-8 w-5/6" />
              <div className="skeleton h-8 w-4/6" />
            </div>
          ) : conversations.length === 0 ? (
            <EmptyConversations />
          ) : filteredConversations.length === 0 ? (
            <NoFilterMatches query={convFilter} onClear={() => setConvFilter("")} />
          ) : (
            <ul className="space-y-0.5">
              {filteredConversations.map((c) => {
                const active = pathname === `/app/chat/${c.id}`;
                const confirming = confirmingId === c.id;
                const deleting = deletingId === c.id;
                const renaming = renamingId === c.id;
                return (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={active}
                    confirming={confirming}
                    deleting={deleting}
                    renaming={renaming}
                    onRequestDelete={() => setConfirmingId(c.id)}
                    onRequestRename={() => setRenamingId(c.id)}
                    onCancelRename={() => setRenamingId(null)}
                    onCommitRename={(t) => void renameConversation(c.id, t)}
                  />
                );
              })}
            </ul>
          )}
        </nav>

        {/* Account + sign-out */}
        <div className={`border-t border-border/70 bg-[color-mix(in_oklab,var(--surface)_55%,transparent)] backdrop-blur-sm ${collapsed ? "p-2" : "p-3"}`}>
          <div className={`flex items-center rounded-lg hover:bg-surface-2/50 ${collapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-1.5"}`}
               style={{
                 transition:
                   "background-color var(--dur-fast) var(--ease-out)",
               }}
          >
            <div
              aria-hidden
              className="relative h-8 w-8 shrink-0 rounded-full bg-linear-to-br from-accent/45 to-accent/10 border border-accent/25 grid place-items-center text-[12px] font-semibold text-foreground"
              title={collapsed ? email : undefined}
            >
              {initial(email)}
              <span
                aria-hidden
                className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-success border-2"
                style={{ borderColor: "var(--surface)" }}
              />
            </div>
            {collapsed ? null : (
              <>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12.5px] text-foreground truncate font-medium"
                    title={email}
                  >
                    {email}
                  </div>
                  <div className="text-[10.5px] text-foreground-subtle">
                    Online
                  </div>
                </div>
                <form action={signOutAction}>
                  <button
                    type="submit"
                    title="Sign out"
                    aria-label="Sign out"
                    className="shrink-0 grid place-items-center h-8 w-8 rounded-md text-foreground-muted hover:text-danger hover:bg-danger/10"
                    style={{
                      transition:
                        "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
                    }}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden
                    >
                      <path
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"
                      />
                      <path
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M10 17l-5-5 5-5M5 12h12"
                      />
                    </svg>
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <button
          aria-label="Close sidebar"
          onClick={() => setMobileOpen(false)}
          className="md:hidden fixed inset-0 z-30 bg-black/60 backdrop-blur-sm"
        />
      ) : null}

      <main className="flex-1 flex flex-col min-w-0 pt-14 md:pt-0">
        {children}
      </main>

      {confirmingConversation ? (
        <ConfirmDeleteDialog
          conversation={confirmingConversation}
          busy={deletingId === confirmingConversation.id}
          onConfirm={() => void deleteConversation(confirmingConversation.id)}
          onCancel={() => setConfirmingId(null)}
        />
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sidebar pieces
// ──────────────────────────────────────────────────────────────────────────
function NavItem({
  href,
  active,
  icon,
  label,
  collapsed,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={`relative flex items-center rounded-lg text-[13px] ${
        collapsed ? "justify-center h-10 w-10 mx-auto" : "gap-2.5 pl-3.5 pr-3 py-2"
      } ${
        active
          ? "bg-surface-2 text-foreground"
          : "text-foreground-muted hover:bg-surface-2/60 hover:text-foreground"
      }`}
      style={{
        transition:
          "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
      }}
    >
      {active && !collapsed ? (
        <span
          aria-hidden
          className="absolute left-1 top-2 bottom-2 w-[3px] rounded-full bg-accent"
        />
      ) : null}
      <span
        className={`shrink-0 ${active ? "text-accent" : "text-foreground-subtle"}`}
      >
        {icon}
      </span>
      {collapsed ? null : <span className="truncate">{label}</span>}
    </Link>
  );
}

function ConversationRow({
  conversation,
  active,
  confirming,
  deleting,
  renaming,
  onRequestDelete,
  onRequestRename,
  onCancelRename,
  onCommitRename,
}: {
  conversation: Conversation;
  active: boolean;
  confirming: boolean;
  deleting: boolean;
  renaming: boolean;
  onRequestDelete: () => void;
  onRequestRename: () => void;
  onCancelRename: () => void;
  onCommitRename: (nextTitle: string) => void;
}) {
  const ts = useMemo(
    () => formatRelativeShort(conversation.updated_at || conversation.created_at),
    [conversation.updated_at, conversation.created_at],
  );
  const title = conversation.title || "New conversation";
  const actionsVisible = confirming || deleting;

  if (renaming) {
    return (
      <li
        className={`group relative rounded-lg ${
          active ? "bg-surface-2" : "bg-surface-2/40"
        } ring-1 ring-accent/40`}
      >
        <RenameInput
          initialValue={title}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      </li>
    );
  }

  return (
    <li
      className={`group relative rounded-lg ${
        active ? "bg-surface-2" : "hover:bg-surface-2/60"
      } ${confirming ? "ring-1 ring-danger/40" : ""}`}
      style={{
        transition:
          "background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
      }}
    >
      <Link
        href={`/app/chat/${conversation.id}`}
        title={title}
        aria-current={active ? "page" : undefined}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRequestRename();
        }}
        className={`relative flex items-center gap-2 rounded-lg pl-3 pr-2 py-2 text-[13px] ${
          active
            ? "text-foreground"
            : "text-foreground-muted group-hover:text-foreground"
        }`}
        style={{
          transition: "color var(--dur-fast) var(--ease-out)",
        }}
      >
        {active ? (
          <span
            aria-hidden
            className="absolute left-0.5 top-2 bottom-2 w-[3px] rounded-full bg-accent"
          />
        ) : null}
        <span
          aria-hidden
          className={`shrink-0 ${active ? "text-accent" : "text-foreground-subtle"}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"
            />
          </svg>
        </span>
        <span className="flex-1 min-w-0 truncate">{title}</span>
        {/* Timestamp — hides when the trash button is shown so they don't fight
            for the same space. */}
        <span className="shrink-0 text-[10.5px] text-foreground-subtle tabular-nums group-hover:opacity-0 group-focus-within:opacity-0 transition-opacity">
          {ts}
        </span>
      </Link>

      {/* Action affordances — hidden until hover/focus. Rename opens an
          inline input; Delete opens the confirm modal. */}
      <div
        className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 ${
          actionsVisible
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
        }`}
        style={{
          transition: "opacity var(--dur-fast) var(--ease-out)",
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRequestRename();
          }}
          disabled={deleting}
          aria-label={`Rename "${title}"`}
          title="Rename"
          className="h-7 w-7 grid place-items-center rounded-md text-foreground-subtle hover:text-foreground hover:bg-surface-2 disabled:opacity-50"
          style={{
            transition:
              "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRequestDelete();
          }}
          disabled={deleting}
          aria-label={`Delete "${title}"`}
          title="Delete"
          className="h-7 w-7 grid place-items-center rounded-md text-foreground-subtle hover:text-danger hover:bg-danger/10 disabled:opacity-50"
          style={{
            transition:
              "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12"
            />
            <path
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              d="M10 11v6M14 11v6"
            />
          </svg>
        </button>
      </div>
    </li>
  );
}

// Inline rename input. Auto-focuses, selects, commits on Enter / blur,
// cancels on Escape. Stops navigation when used inside the row's <Link>.
function RenameInput({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => {
        const trimmed = value.trim();
        if (!trimmed || trimmed === initialValue) onCancel();
        else onCommit(value);
      }}
      onClick={(e) => e.stopPropagation()}
      aria-label="Rename conversation"
      className="w-full bg-surface-1 text-[13px] text-foreground rounded-lg pl-3 pr-2 py-2 outline-none ring-1 ring-accent/50 focus:ring-accent"
      style={{
        transition: "box-shadow var(--dur-fast) var(--ease-out)",
      }}
    />
  );
}

function ConversationFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-subtle"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter conversations…"
        aria-label="Filter conversations"
        className="w-full bg-surface-2/60 hover:bg-surface-2 focus:bg-surface-2 text-[12.5px] text-foreground placeholder:text-foreground-subtle rounded-md pl-8 pr-2.5 h-8 outline-none focus-ring"
        style={{
          transition: "background-color var(--dur-fast) var(--ease-out)",
        }}
      />
    </div>
  );
}

function NoFilterMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="mt-1 mx-2 rounded-lg border border-dashed border-border bg-surface-2/30 px-3 py-4 text-center">
      <p className="text-[12px] text-foreground-muted">
        No matches for{" "}
        <span className="text-foreground font-medium">&ldquo;{query}&rdquo;</span>.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-1.5 text-[11.5px] text-accent hover:text-accent-strong font-medium"
        style={{ transition: "color var(--dur-fast) var(--ease-out)" }}
      >
        Clear filter
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Confirm delete modal
// ──────────────────────────────────────────────────────────────────────────
function ConfirmDeleteDialog({
  conversation,
  busy,
  onConfirm,
  onCancel,
}: {
  conversation: Conversation;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const title = conversation.title || "New conversation";
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe default (Cancel) when opened; Escape closes the dialog.
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
      aria-describedby="confirm-delete-desc"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => {
          if (!busy) onCancel();
        }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        style={{ cursor: busy ? "default" : "pointer" }}
      />

      {/* Panel */}
      <div
        className="fade-up relative w-full max-w-md surface-elevated rounded-2xl p-6"
        style={{
          animation: "fadeUp var(--dur-med) var(--ease-spring) both",
        }}
      >
        <div className="flex items-start gap-3.5">
          <span
            aria-hidden
            className="shrink-0 grid place-items-center h-10 w-10 rounded-full bg-danger/12 text-danger"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="confirm-delete-title"
              className="text-[15.5px] font-semibold tracking-tight text-foreground"
            >
              Delete this conversation?
            </h2>
            <p
              id="confirm-delete-desc"
              className="mt-1.5 text-[13px] leading-relaxed text-foreground-muted"
            >
              <span className="text-foreground">
                &ldquo;<span className="font-medium">{title}</span>&rdquo;
              </span>{" "}
              and all of its messages will be permanently removed. This
              can&rsquo;t be undone.
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-9 px-3.5 rounded-md text-[13px] font-medium text-foreground-muted hover:text-foreground hover:bg-surface-2 disabled:opacity-50"
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
            className="h-9 px-3.5 rounded-md text-[13px] font-medium text-white bg-danger hover:bg-danger/90 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            style={{
              transition:
                "background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)",
            }}
          >
            {busy ? (
              <>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                  className="animate-spin"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    stroke="currentColor"
                    strokeOpacity="0.35"
                    strokeWidth="2.5"
                  />
                  <path
                    d="M21 12a9 9 0 00-9-9"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>
                Deleting…
              </>
            ) : (
              "Delete"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyConversations() {
  return (
    <div className="mt-1 mx-2 rounded-lg border border-dashed border-border bg-surface-2/30 px-3 py-4 text-center">
      <span
        aria-hidden
        className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-surface-2 text-foreground-subtle"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"
          />
        </svg>
      </span>
      <p className="mt-2 text-[12px] text-foreground-muted">
        No conversations yet.
      </p>
      <p className="text-[11px] text-foreground-subtle mt-0.5">
        Start one with the{" "}
        <span className="text-foreground-muted font-medium">New chat</span>{" "}
        button above.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function initial(email: string): string {
  const trimmed = (email || "").trim();
  if (!trimmed) return "·";
  return trimmed.charAt(0).toUpperCase();
}

/** Tight relative time format suitable for the sidebar — "now", "5m", "3h",
 *  "2d", "Apr 7". */
function formatRelativeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

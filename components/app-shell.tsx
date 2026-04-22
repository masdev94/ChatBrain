"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandMark } from "@/components/brand";
import { signOutAction } from "@/app/auth/actions";
import { api, type Conversation } from "@/lib/api";

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
  // Which conversation (if any) is in "click again to confirm delete" mode.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Tracks the in-flight delete so we can disable both buttons while it runs.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

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
    setDeletingId(id);
    setConfirmingId(null);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      await api.conversations.remove(id);
      if (pathname === `/app/chat/${id}`) {
        router.push("/app");
      }
    } catch {
      // Restore the list so the user doesn't silently lose their row.
      setConversations(snapshot);
    } finally {
      setDeletingId(null);
    }
  };

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
          style={{ transition: "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)" }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
      </header>

      <aside
        aria-label="Primary"
        className={`fixed md:static inset-y-0 left-0 z-40 w-72 shrink-0 border-r border-border bg-surface flex flex-col md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ transition: "transform var(--dur-med) var(--ease-out)" }}
      >
        {/* Sidebar header */}
        <div className="h-16 flex items-center px-5 border-b border-border">
          <Link href="/app" className="flex items-center gap-2 focus-ring rounded-md -mx-1 px-1 py-1">
            <BrandMark size={24} />
          </Link>
        </div>

        {/* Primary actions */}
        <div className="p-3 space-y-1.5">
          <button
            onClick={newChat}
            disabled={creating}
            className="group w-full flex items-center justify-center gap-2 rounded-md bg-accent text-[#0b0d12] font-medium py-2.5 text-sm disabled:opacity-60 hover:bg-accent-strong"
            style={{
              transition:
                "background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                d="M12 5v14M5 12h14"
              />
            </svg>
            New chat
          </button>

          <NavItem
            href="/app/sources"
            active={pathname === "/app/sources"}
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
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

        {/* Conversations list */}
        <div className="px-5 pb-2 pt-3 text-[10.5px] uppercase tracking-[0.14em] font-medium text-foreground-subtle">
          Conversations
        </div>
        <nav aria-label="Conversations" className="flex-1 overflow-y-auto px-2 pb-4">
          {loading ? (
            <div className="space-y-1.5 px-2 pt-1">
              <div className="skeleton h-7 w-full" />
              <div className="skeleton h-7 w-5/6" />
              <div className="skeleton h-7 w-4/6" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-3 py-2 text-xs text-foreground-subtle">
              No conversations yet.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((c) => {
                const active = pathname === `/app/chat/${c.id}`;
                const confirming = confirmingId === c.id;
                const deleting = deletingId === c.id;
                return (
                  <li
                    key={c.id}
                    className={`group relative rounded-md ${
                      active
                        ? "bg-surface-2"
                        : "hover:bg-surface-2"
                    } ${confirming ? "ring-1 ring-danger/40" : ""}`}
                    style={{
                      transition:
                        "background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
                    }}
                  >
                    <Link
                      href={`/app/chat/${c.id}`}
                      title={c.title}
                      aria-current={active ? "page" : undefined}
                      className={`relative block truncate rounded-md pl-4 pr-10 py-2 text-sm ${
                        active
                          ? "text-foreground"
                          : "text-foreground-muted group-hover:text-foreground"
                      }`}
                      style={{
                        transition:
                          "color var(--dur-fast) var(--ease-out)",
                      }}
                    >
                      {active ? (
                        <span
                          aria-hidden
                          className="absolute left-1 top-2 bottom-2 w-[3px] rounded-full bg-accent"
                        />
                      ) : null}
                      {c.title || "New conversation"}
                    </Link>

                    {/* Delete affordance. Hidden by default, revealed on row
                        hover or when focused via keyboard. Once armed,
                        expands into a confirm / cancel pair so a single
                        misclick can't destroy history. */}
                    <div
                      className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 ${
                        confirming
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                      }`}
                      style={{
                        transition: "opacity var(--dur-fast) var(--ease-out)",
                      }}
                    >
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void deleteConversation(c.id);
                            }}
                            disabled={deleting}
                            aria-label="Confirm delete"
                            title="Confirm delete"
                            className="h-7 w-7 grid place-items-center rounded-md text-danger bg-danger/10 hover:bg-danger/20 disabled:opacity-50"
                            style={{
                              transition:
                                "background-color var(--dur-fast) var(--ease-out)",
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                              <path
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M5 12l5 5L20 7"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setConfirmingId(null);
                            }}
                            disabled={deleting}
                            aria-label="Cancel"
                            title="Cancel"
                            className="h-7 w-7 grid place-items-center rounded-md text-foreground-muted hover:text-foreground hover:bg-surface"
                            style={{
                              transition:
                                "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                              <path
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M6 6l12 12M18 6L6 18"
                              />
                            </svg>
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setConfirmingId(c.id);
                          }}
                          aria-label={`Delete "${c.title || "New conversation"}"`}
                          title="Delete"
                          className="h-7 w-7 grid place-items-center rounded-md text-foreground-subtle hover:text-danger hover:bg-danger/10"
                          style={{
                            transition:
                              "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
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
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        {/* Account + sign-out */}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2.5 rounded-lg bg-surface-2/60 border border-border px-2.5 py-2">
            <div
              aria-hidden
              className="h-8 w-8 shrink-0 rounded-full bg-gradient-to-br from-accent/40 to-accent/10 border border-accent/25 grid place-items-center text-[12px] font-semibold text-foreground"
            >
              {initial(email)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] text-foreground truncate font-medium">
                {email}
              </div>
              <div className="text-[10.5px] text-foreground-subtle">
                Signed in
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
                  width="16"
                  height="16"
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

      <main className="flex-1 flex flex-col min-w-0 pt-14 md:pt-0">{children}</main>
    </div>
  );
}

function NavItem({
  href,
  active,
  icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-2.5 rounded-md pl-4 pr-3 py-2 text-sm ${
        active
          ? "bg-surface-2 text-foreground"
          : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
      }`}
      style={{
        transition:
          "background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
      }}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute left-1 top-2 bottom-2 w-[3px] rounded-full bg-accent"
        />
      ) : null}
      <span className={active ? "text-accent" : "text-foreground-muted"}>{icon}</span>
      {label}
    </Link>
  );
}

function initial(email: string): string {
  const trimmed = (email || "").trim();
  if (!trimmed) return "·";
  return trimmed.charAt(0).toUpperCase();
}

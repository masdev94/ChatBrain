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
  const pathname = usePathname();
  const router = useRouter();

  // Re-fetch the sidebar list whenever the route changes (so a newly created
  // conversation appears, a renamed one updates, etc.). Inline fetch +
  // cancel-flag keeps the effect free of cascading setState.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.conversations.list();
        if (!cancelled) setConversations(list);
      } catch {
        /* ignore; errors surface in pages */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Close the mobile drawer whenever the pathname actually changes. Using
  // the "store previous value in state" pattern avoids both an effect and
  // a ref-write-during-render.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (mobileOpen) setMobileOpen(false);
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

  return (
    <div className="min-h-screen flex bg-background">
      {/* Mobile top bar */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 flex items-center justify-between px-4 h-14 border-b border-border bg-surface/90 backdrop-blur">
        <BrandMark size={24} />
        <button
          aria-label="Toggle sidebar"
          onClick={() => setMobileOpen((v) => !v)}
          className="rounded-md p-2 hover:bg-surface-2 text-foreground-muted hover:text-foreground transition"
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

      {/* Sidebar */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-72 shrink-0 border-r border-border bg-surface flex flex-col transition-transform md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="h-16 flex items-center px-4 border-b border-border">
          <Link href="/app" className="flex items-center gap-2">
            <BrandMark size={26} />
          </Link>
        </div>

        <div className="p-3 space-y-2">
          <button
            onClick={newChat}
            disabled={creating}
            className="w-full flex items-center justify-center gap-2 rounded-md bg-accent hover:bg-accent-strong text-[#0b0d12] font-medium py-2 transition disabled:opacity-60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                d="M12 5v14M5 12h14"
              />
            </svg>
            New chat
          </button>

          <Link
            href="/app/sources"
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
              pathname === "/app/sources"
                ? "bg-surface-2 text-foreground"
                : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 6a2 2 0 012-2h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"
              />
              <path
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                d="M14 4v5h5"
              />
            </svg>
            Knowledge base
          </Link>
        </div>

        <div className="px-3 pb-2 pt-1 text-[11px] uppercase tracking-wider text-foreground-muted">
          Conversations
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {loading ? (
            <div className="px-3 py-2 text-xs text-foreground-muted">
              Loading…
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-3 py-2 text-xs text-foreground-muted">
              No conversations yet.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((c) => {
                const active = pathname === `/app/chat/${c.id}`;
                return (
                  <li key={c.id}>
                    <Link
                      href={`/app/chat/${c.id}`}
                      className={`block truncate rounded-md px-3 py-2 text-sm transition ${
                        active
                          ? "bg-surface-2 text-foreground"
                          : "text-foreground-muted hover:bg-surface-2 hover:text-foreground"
                      }`}
                      title={c.title}
                    >
                      {c.title || "New conversation"}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <form action={signOutAction} className="border-t border-border p-3">
          <div className="text-xs text-foreground-muted truncate mb-2">
            {email}
          </div>
          <button
            type="submit"
            className="w-full text-left rounded-md px-3 py-2 text-sm text-foreground-muted hover:bg-surface-2 hover:text-foreground transition"
          >
            Sign out
          </button>
        </form>
      </aside>

      {mobileOpen ? (
        <button
          aria-label="Close sidebar"
          onClick={() => setMobileOpen(false)}
          className="md:hidden fixed inset-0 z-30 bg-black/60"
        />
      ) : null}

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 md:ml-0 pt-14 md:pt-0">
        {children}
      </main>
    </div>
  );
}

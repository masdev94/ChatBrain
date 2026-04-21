"use client";

import { createBrowserClient } from "@supabase/ssr";

// Singleton browser client. Re-creating the client per render would reset
// its in-memory session cache and trigger redundant auth refreshes.
let _client: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowserClient() {
  if (!_client) {
    _client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return _client;
}

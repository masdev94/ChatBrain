import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// In Next.js 16, `cookies()` is async (like every other Request-time API).
// The Supabase SSR client is deliberately kept per-request so writes to the
// session cookie during token refresh are reflected in the response.
export async function getSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // We intentionally swallow this: when called from a Server
            // Component (read-only context) Next.js forbids mutation. The
            // proxy is responsible for refreshing the session cookie; this
            // call here is a best-effort no-op in that case.
          }
        },
      },
    },
  );
}

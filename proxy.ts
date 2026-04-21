// Next.js 16 renamed `middleware` → `proxy`. This file runs on every
// request so we can refresh the user's Supabase session and guard private
// routes. The heavy lifting lives in `lib/supabase/proxy.ts`.

import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Skip static assets and Next internals. Everything else passes through
  // so session refresh and route-protection run.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

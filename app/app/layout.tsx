import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The proxy already redirects unauthenticated users, but we re-verify here
  // so a server component never reads data on behalf of a nonexistent user.
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/sign-in");

  return <AppShell email={user.email ?? "Signed in"}>{children}</AppShell>;
}

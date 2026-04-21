"use server";

import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export interface AuthResult {
  error?: string;
}

function validate(email: string, password: string): string | null {
  if (!email || !email.includes("@")) return "Enter a valid email address.";
  if (!password || password.length < 8)
    return "Password must be at least 8 characters.";
  return null;
}

export async function signInAction(formData: FormData): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/app");

  const bad = validate(email, password);
  if (bad) return { error: bad };

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };

  redirect(next.startsWith("/") ? next : "/app");
}

export async function signUpAction(formData: FormData): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  const bad = validate(email, password);
  if (bad) return { error: bad };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message };

  // If "Confirm email" is disabled the user is auto-signed-in; otherwise send
  // them to the sign-in page with a hint to check their inbox.
  if (data.session) redirect("/app");
  redirect("/sign-in?checkEmail=1");
}

export async function signOutAction() {
  const supabase = await getSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}

import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/app";
  const checkEmail = sp.checkEmail === "1";

  return (
    <div className="min-h-screen grid place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-8">
          <BrandMark size={36} />
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-lg shadow-black/30">
          <h1 className="text-xl font-semibold mb-1">Welcome back</h1>
          <p className="text-sm text-foreground-muted mb-6">
            Sign in to your knowledge base.
          </p>
          {checkEmail ? (
            <div className="mb-4 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
              Check your inbox to confirm your email, then sign in.
            </div>
          ) : null}
          <SignInForm next={next} />
        </div>
        <p className="text-center text-sm text-foreground-muted mt-6">
          Don&apos;t have an account?{" "}
          <Link
            href="/sign-up"
            className="text-accent hover:text-accent-strong font-medium"
          >
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}

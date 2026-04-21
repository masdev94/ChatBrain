import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { SignUpForm } from "./sign-up-form";

export default function SignUpPage() {
  return (
    <div className="min-h-screen grid place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-8">
          <BrandMark size={36} />
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-lg shadow-black/30">
          <h1 className="text-xl font-semibold mb-1">Create your account</h1>
          <p className="text-sm text-foreground-muted mb-6">
            Start building your personal second brain.
          </p>
          <SignUpForm />
        </div>
        <p className="text-center text-sm text-foreground-muted mt-6">
          Already have an account?{" "}
          <Link
            href="/sign-in"
            className="text-accent hover:text-accent-strong font-medium"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

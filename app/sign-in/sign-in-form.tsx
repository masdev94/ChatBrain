"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signInAction, type AuthResult } from "@/app/auth/actions";

async function onSubmit(
  _prev: AuthResult | null,
  formData: FormData,
): Promise<AuthResult | null> {
  return await signInAction(formData);
}

export function SignInForm({ next }: { next: string }) {
  const [state, action] = useActionState(onSubmit, null);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@domain.com"
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        placeholder="••••••••"
        minLength={8}
      />
      {state?.error ? (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      ) : null}
      <Submit>Sign in</Submit>
    </form>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
  minLength,
  placeholder,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete?: string;
  minLength?: number;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-foreground mb-1.5">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        minLength={minLength}
        placeholder={placeholder}
        className="w-full h-11 rounded-md border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-accent/60"
        style={{
          transition:
            "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
        }}
      />
    </label>
  );
}

function Submit({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full h-11 rounded-md bg-accent hover:bg-accent-strong text-[#0b0d12] font-medium text-sm disabled:opacity-60 disabled:cursor-not-allowed"
      style={{
        transition:
          "background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)",
      }}
    >
      {pending ? "Signing in…" : children}
    </button>
  );
}

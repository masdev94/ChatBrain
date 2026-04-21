"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signUpAction, type AuthResult } from "@/app/auth/actions";

async function onSubmit(
  _prev: AuthResult | null,
  formData: FormData,
): Promise<AuthResult | null> {
  return await signUpAction(formData);
}

export function SignUpForm() {
  const [state, action] = useActionState(onSubmit, null);

  return (
    <form action={action} className="space-y-3">
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
      />
      <p className="text-xs text-foreground-muted">
        At least 8 characters.
      </p>
      {state?.error ? (
        <p className="text-sm text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
      <Submit>Create account</Submit>
    </form>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
  minLength,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete?: string;
  minLength?: number;
}) {
  return (
    <label className="block">
      <span className="block text-sm text-foreground-muted mb-1">{label}</span>
      <input
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        minLength={minLength}
        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-foreground focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 transition"
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
      className="w-full rounded-md bg-accent hover:bg-accent-strong text-[#0b0d12] font-medium py-2 transition disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {pending ? "Creating…" : children}
    </button>
  );
}

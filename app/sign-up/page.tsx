import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { SignUpForm } from "./sign-up-form";

export default function SignUpPage() {
  return (
    <div className="relative flex-1 min-h-screen w-full overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 dot-grid opacity-[0.35] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]"
      />
      <span aria-hidden className="orb orb--amber -left-40 -top-32" />
      <span aria-hidden className="orb -bottom-40 -right-40" />

      <div className="relative z-10 grid min-h-screen lg:grid-cols-[1.05fr_minmax(0,1fr)]">
        <aside className="hidden lg:flex flex-col justify-between px-16 py-14">
          <div className="fade-up">
            <BrandMark size={28} />
          </div>

          <div className="max-w-xl space-y-8">
            <h1 className="fade-up delay-1 text-[clamp(2.75rem,4vw,3.75rem)] leading-[1.05] tracking-[-0.035em] font-bold">
              Start building
              <br />
              <span className="text-foreground-muted">your second brain.</span>
            </h1>
            <p className="fade-up delay-2 text-lg leading-relaxed text-foreground-muted max-w-md">
              Drop in a PDF, paste a note, add a URL. ChatBrain indexes it,
              chats about it, and cites it back — nothing more, nothing less.
            </p>
            <ul className="fade-up delay-3 space-y-3 text-sm text-foreground-muted">
              <Step n={1}>Add the sources you want the assistant to know.</Step>
              <Step n={2}>Ask anything in plain language.</Step>
              <Step n={3}>Verify every claim against the original passage.</Step>
            </ul>
          </div>

          <p className="fade-up delay-4 text-xs text-foreground-subtle">
            Free to start. No credit card.
          </p>
        </aside>

        <section className="flex items-center justify-center px-4 sm:px-8 py-12 lg:py-0">
          <div className="w-full max-w-sm">
            <div className="lg:hidden fade-up flex items-center justify-center mb-8">
              <BrandMark size={30} />
            </div>

            <div className="fade-up delay-1 surface-elevated rounded-2xl p-7">
              <h2 className="text-2xl font-bold tracking-tight mb-1">
                Create your account
              </h2>
              <p className="text-sm text-foreground-muted mb-6">
                One account, as many sources as you like.
              </p>
              <SignUpForm />
            </div>

            <p className="fade-up delay-2 text-center text-sm text-foreground-muted mt-6">
              Already a member?{" "}
              <Link
                href="/sign-in"
                className="text-accent hover:text-accent-strong font-medium"
                style={{
                  transition: "color var(--dur-fast) var(--ease-out)",
                }}
              >
                Sign in
              </Link>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[11px] font-mono text-accent"
      >
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

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
    <div className="relative flex-1 min-h-screen w-full overflow-hidden">
      {/* Depth: a single cool orb top-left and a soft amber orb bottom-right,
          plus a low-opacity dot grid under everything. Kept behind content. */}
      <div
        aria-hidden
        className="absolute inset-0 dot-grid opacity-[0.35] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]"
      />
      <span aria-hidden className="orb -left-40 -top-40" />
      <span aria-hidden className="orb orb--amber -bottom-32 -right-24" />

      <div className="relative z-10 grid min-h-screen lg:grid-cols-[1.05fr_minmax(0,1fr)]">
        {/* Editorial left column — hidden on mobile/tablet to keep focus on
            the form. Uses the display type scale + tight tracking. */}
        <aside className="hidden lg:flex flex-col justify-between px-16 py-14">
          <div className="fade-up">
            <BrandMark size={28} />
          </div>

          <div className="max-w-xl space-y-8">
            <h1 className="fade-up delay-1 text-[clamp(2.75rem,4vw,3.75rem)] leading-[1.05] tracking-[-0.035em] font-bold">
              Your knowledge,
              <br />
              <span className="text-foreground-muted">answered back.</span>
            </h1>
            <p className="fade-up delay-2 text-lg leading-relaxed text-foreground-muted max-w-md">
              ChatBrain turns your PDFs, notes, and bookmarks into a chat
              partner that only speaks from what you&rsquo;ve given it — and
              shows its work along the way.
            </p>
            <ul className="fade-up delay-3 space-y-3 text-sm text-foreground-muted">
              <Feature>Grounded answers with inline citations.</Feature>
              <Feature>Streaming reasoning you can audit.</Feature>
              <Feature>Private by default — your sources stay yours.</Feature>
            </ul>
          </div>

          <p className="fade-up delay-4 text-xs text-foreground-subtle">
            Built for people who read more than they publish.
          </p>
        </aside>

        {/* Form column */}
        <section className="flex items-center justify-center px-4 sm:px-8 py-12 lg:py-0">
          <div className="w-full max-w-sm">
            {/* Mobile-only brand */}
            <div className="lg:hidden fade-up flex items-center justify-center mb-8">
              <BrandMark size={30} />
            </div>

            <div className="fade-up delay-1 surface-elevated rounded-2xl p-7">
              <h2 className="text-2xl font-bold tracking-tight mb-1">
                Welcome back
              </h2>
              <p className="text-sm text-foreground-muted mb-6">
                Sign in to your second brain.
              </p>

              {checkEmail ? (
                <div
                  role="status"
                  className="mb-5 rounded-md border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success"
                >
                  Check your inbox to confirm your email, then sign in.
                </div>
              ) : null}

              <SignInForm next={next} />
            </div>

            <p className="fade-up delay-2 text-center text-sm text-foreground-muted mt-6">
              New here?{" "}
              <Link
                href="/sign-up"
                className="text-accent hover:text-accent-strong font-medium"
                style={{
                  transition: "color var(--dur-fast) var(--ease-out)",
                }}
              >
                Create an account
              </Link>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden
        className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
      />
      <span>{children}</span>
    </li>
  );
}

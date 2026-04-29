import { SourcesView } from "./sources-view";

export const metadata = { title: "Knowledge base · ChatBrain" };

export default function SourcesPage() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 md:px-8 py-8 md:py-10">
        <header className="mb-8 fade-up flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 mb-2">
              <span
                aria-hidden
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent border border-accent/20"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 6a2 2 0 012-2h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"
                  />
                  <path
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    d="M14 4v5h5"
                  />
                </svg>
              </span>
              <span className="text-[11px] uppercase tracking-[0.14em] text-foreground-subtle font-medium">
                Knowledge base
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-[-0.02em] text-foreground">
              Your sources
            </h1>
            <p className="text-[14px] leading-relaxed text-foreground-muted mt-2 max-w-lg">
              Upload PDFs, paste text, or add URLs. Every answer is grounded in
              these sources and cites where each claim came from.
            </p>
          </div>
        </header>
        <div className="fade-up delay-1">
          <SourcesView />
        </div>
      </div>
    </div>
  );
}

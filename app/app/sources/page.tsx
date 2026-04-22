import { SourcesView } from "./sources-view";

export const metadata = { title: "Knowledge base · ChatBrain" };

export default function SourcesPage() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 md:px-8 py-10">
        <header className="mb-8 fade-up">
          <div className="text-[11px] uppercase tracking-[0.16em] text-foreground-subtle font-medium mb-2">
            Knowledge base
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-[-0.02em] text-foreground">
            What should your brain know?
          </h1>
          <p className="text-[15px] leading-relaxed text-foreground-muted mt-3 max-w-xl">
            Upload PDFs, paste text, or add URLs. Your chatbot answers from
            these sources and nothing else — so every reply is grounded and
            cited.
          </p>
        </header>
        <div className="fade-up delay-1">
          <SourcesView />
        </div>
      </div>
    </div>
  );
}

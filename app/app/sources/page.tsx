import { SourcesView } from "./sources-view";

export const metadata = { title: "Knowledge base · ChatBrain" };

export default function SourcesPage() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 md:px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Knowledge base
          </h1>
          <p className="text-sm text-foreground-muted mt-1">
            Upload PDFs, paste text, or add URLs. Your chatbot will answer
            from these sources and nothing else.
          </p>
        </header>
        <SourcesView />
      </div>
    </div>
  );
}

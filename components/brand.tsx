export function BrandMark({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex items-center gap-2 ${className}`}
      aria-label="ChatBrain"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="cb-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7c9cff" />
            <stop offset="1" stopColor="#b48cff" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill="url(#cb-g)" />
        <path
          d="M10 12c0-2.21 1.79-4 4-4h4a4 4 0 014 4v1.5a3 3 0 010 5.94V21a4 4 0 01-4 4h-4a4 4 0 01-4-4v-9zm3 0a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1v-1a1 1 0 011-1h0.5a1 1 0 000-2H20a1 1 0 01-1-1v-4a1 1 0 00-1-1h-5z"
          fill="white"
          fillOpacity="0.95"
        />
      </svg>
      <span className="font-semibold tracking-tight text-foreground">
        ChatBrain
      </span>
    </div>
  );
}

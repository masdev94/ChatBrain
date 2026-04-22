/**
 * ChatBrain wordmark + monogram.
 *
 * The mark is a stacked "speech bubble crossed with a glyph" — a nod to both
 * "chat" and "brain / knowledge". We use the cool primary as the fill and a
 * warm amber hairline as a spark, mirroring the product's accent system so
 * the logo reinforces the palette rather than introducing a new hue.
 */
export function BrandMark({
  size = 28,
  className = "",
  showWordmark = true,
}: {
  size?: number;
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <div
      className={`inline-flex items-center gap-2.5 ${className}`}
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
          <linearGradient id="cb-primary" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7c9cff" />
            <stop offset="1" stopColor="#4864d8" />
          </linearGradient>
        </defs>
        {/* Rounded-square tile. 12% rounding to match component language. */}
        <rect width="32" height="32" rx="9" fill="url(#cb-primary)" />
        {/* Monogram: a thick bracket on the left signals "container",
            an inner slash signals "signal in". Editorial, not literal. */}
        <path
          d="M10.5 9.5h8.6a3.4 3.4 0 013.4 3.4v5.2a3.4 3.4 0 01-3.4 3.4H14l-3.7 2.7v-2.7h-0.3v-12z"
          fill="#0b0d12"
          fillOpacity="0.22"
        />
        <path
          d="M11.8 10.8h7.1a2.3 2.3 0 012.3 2.3v4.5a2.3 2.3 0 01-2.3 2.3h-4.3l-2.8 2v-2h-0v-9.1z"
          stroke="white"
          strokeOpacity="0.95"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Amber spark — single warm pixel that echoes the streaming caret. */}
        <circle cx="21.5" cy="10.5" r="1.6" fill="#f4b860" />
      </svg>
      {showWordmark ? (
        <span className="font-semibold tracking-tight text-foreground text-[15px]">
          Chat<span className="text-foreground-muted">Brain</span>
        </span>
      ) : null}
    </div>
  );
}

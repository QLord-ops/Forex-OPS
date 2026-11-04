/** OPS FOREX mark "Сеть": the dispatch hub and its four directions. Colours come from the --brand-* tokens of the theme. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <g stroke="var(--brand-mark)" strokeWidth="4" strokeLinecap="round">
        <path d="M32 32 10 12M32 32l24-8M32 32 18 54M32 32l20 22" />
      </g>
      <g fill="var(--brand-mark)">
        <circle cx="10" cy="12" r="6" />
        <circle cx="56" cy="24" r="6" />
        <circle cx="18" cy="54" r="6" />
        <circle cx="52" cy="54" r="6" />
      </g>
      <circle cx="32" cy="32" r="11" fill="var(--brand-mark-2)" />
      <circle cx="32" cy="32" r="4" fill="var(--brand-hole, var(--surface))" />
    </svg>
  )
}

export function BrandWordmark({ className = '', subtitle = true }: { className?: string; subtitle?: boolean }) {
  return (
    <span className={`brand-wordmark ${className}`.trim()}>
      <span className="brand-wordmark-name"><b>OPS</b> <span>FOREX</span></span>
      {subtitle ? <span className="brand-wordmark-sub">DISPONENT</span> : null}
    </span>
  )
}

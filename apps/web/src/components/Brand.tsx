/** OPS FOREX mark: a stop's arrival zone with the truck inside it. */
export function BrandMark({ size = 32, framed = true }: { size?: number; framed?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false" className="brand-mark">
    {framed ? <rect x=".75" y=".75" width="46.5" height="46.5" rx="11.5" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
    <circle cx="24" cy="24" r="13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.5 2.5" />
    <circle cx="24" cy="24" r="7.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <circle cx="24" cy="24" r="2.6" fill="var(--brand-ivory)" />
  </svg>
}

export function BrandWordmark({ className = '' }: { className?: string }) {
  return <span className={`brand-wordmark ${className}`.trim()}><b>OPS</b><span>FOREX</span></span>
}

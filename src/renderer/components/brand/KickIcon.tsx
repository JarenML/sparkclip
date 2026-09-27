/** A blocky "K" in the style of Kick's glyph, for source badges (lucide has no Kick icon). */
export function KickIcon({ className, ...props }: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} {...props}>
      <path d="M3 3h6v5h2V5.5h2.5V3h6v6.5H17V12h2.5v2.5H17V17h2.5v4h-6v-2.5H11V16H9v5H3z" />
    </svg>
  )
}

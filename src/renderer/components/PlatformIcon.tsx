import type { CSSProperties } from 'react'
import { Share2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { ZERNIO_PLATFORM_NAMES, type ZernioPlatform } from '../../shared/zernio'
import { PLATFORM_MARKS } from './brand/PlatformMarks'

interface PlatformInfo {
  name: string
  /** Shown under the name; only for requirements that decide whether connecting works. */
  note?: string
}

export const PLATFORM_INFO: Record<ZernioPlatform, PlatformInfo> = {
  tiktok: { name: ZERNIO_PLATFORM_NAMES.tiktok },
  youtube: { name: ZERNIO_PLATFORM_NAMES.youtube, note: 'Clips under 3 minutes post as Shorts' },
  instagram: { name: ZERNIO_PLATFORM_NAMES.instagram, note: 'Needs a Business or Creator account' },
  facebook: { name: ZERNIO_PLATFORM_NAMES.facebook, note: 'Posts to a Page you manage' },
  twitter: { name: ZERNIO_PLATFORM_NAMES.twitter, note: 'Zernio needs a card on file for X' },
  linkedin: { name: ZERNIO_PLATFORM_NAMES.linkedin, note: 'Your profile or a company Page' },
  threads: { name: ZERNIO_PLATFORM_NAMES.threads }
}

/** Each platform's app-icon background, behind its white mark. */
const BRAND_BACKGROUND: Record<string, string> = {
  tiktok: '#000000',
  youtube: '#ff0033',
  instagram: 'linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)',
  facebook: '#0866ff',
  twitter: '#000000',
  linkedin: '#0a66c2',
  threads: '#000000',
  // Connected in Zernio itself; SparkClip doesn't offer it.
  pinterest: '#e60023'
}

/** X's mark, drawn here; the others come from Simple Icons. */
const X_MARK = 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'

/** The platform's mark as a monochrome 24×24 glyph, or null for one SparkClip doesn't know. */
export function PlatformMark({ platform, className }: { platform: string; className?: string }): React.JSX.Element | null {
  const path = platform === 'twitter' ? X_MARK : PLATFORM_MARKS[platform]
  if (!path) return null
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d={path} />
    </svg>
  )
}

export function platformName(platform: string): string {
  return (PLATFORM_INFO as Record<string, PlatformInfo>)[platform]?.name ?? platform.charAt(0).toUpperCase() + platform.slice(1)
}

interface PlatformIconProps {
  platform: string
  className?: string
  /** `tile` (default): a glass lens. `glyph`: the bare mark, for inline chips. */
  variant?: 'tile' | 'glyph'
}

export function PlatformIcon({ platform, className, variant = 'tile' }: PlatformIconProps): React.JSX.Element {
  const mark = PlatformMark({ platform, className: 'h-[18px] w-[18px]' })
  const glyph = mark ?? <Share2 className="h-4 w-4" strokeWidth={1.9} />

  if (variant === 'glyph') {
    return <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center text-ink [&_svg]:h-3 [&_svg]:w-3', className)}>{glyph}</span>
  }

  const background = BRAND_BACKGROUND[platform]
  const style: CSSProperties = { background: background ?? 'rgb(255 255 255 / 0.08)' }
  return (
    <span
      aria-hidden
      data-platform-icon={platform}
      style={style}
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white',
        'shadow-[inset_0_1px_0_rgb(255_255_255/0.2),inset_0_0_0_1px_rgb(255_255_255/0.14),0_6px_16px_-8px_rgb(0_0_0/0.6)]',
        className
      )}
    >
      {glyph}
    </span>
  )
}

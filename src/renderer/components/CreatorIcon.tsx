import { Instagram, Music2, Twitch, Youtube } from 'lucide-react'
import type { CreatorPlatform } from '../../shared/creators'
import { cn } from '../lib/utils'
import { KickIcon } from './brand/KickIcon'

const COLORS: Record<CreatorPlatform, string> = {
  youtube: 'text-[#ff0033]', twitch: 'text-[#a970ff]', kick: 'text-[#53fc18]',
  tiktok: 'text-[#25f4ee]', instagram: 'text-[#e1306c]', x: 'text-ink'
}

/** A creator platform's mark, in its brand color. */
export function CreatorIcon({ platform, className }: { platform: CreatorPlatform; className?: string }): React.JSX.Element {
  const classes = cn('h-3.5 w-3.5 shrink-0', COLORS[platform], className)
  if (platform === 'youtube') return <Youtube aria-hidden className={classes} />
  if (platform === 'twitch') return <Twitch aria-hidden className={classes} />
  if (platform === 'kick') return <KickIcon aria-hidden className={classes} />
  if (platform === 'instagram') return <Instagram aria-hidden className={classes} />
  if (platform === 'tiktok') return <Music2 aria-hidden className={classes} />
  return <span aria-hidden className={cn('inline-flex items-center justify-center font-semibold leading-none', classes)}>𝕏</span>
}

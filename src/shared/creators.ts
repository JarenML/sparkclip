/** Creators: people whose YouTube, Twitch and Kick uploads the app follows. */

/** Platforms whose videos the app can list. */
export const FEED_PLATFORMS = ['youtube', 'twitch', 'kick'] as const
export type FeedPlatform = (typeof FEED_PLATFORMS)[number]

/** Platforms kept only as a link to open in the browser. */
export const LINK_PLATFORMS = ['tiktok', 'instagram', 'x'] as const
export type CreatorPlatform = FeedPlatform | (typeof LINK_PLATFORMS)[number]
export const CREATOR_PLATFORMS: readonly CreatorPlatform[] = [...FEED_PLATFORMS, ...LINK_PLATFORMS]

export const CREATOR_PLATFORM_NAMES: Record<CreatorPlatform, string> = {
  youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick', tiktok: 'TikTok', instagram: 'Instagram', x: 'X'
}

export interface Creator {
  id: string
  name: string
  /** Canonical profile links, by platform. */
  links: Partial<Record<CreatorPlatform, string>>
  /** Desktop notifications for new uploads and going live. */
  notify: boolean
  createdAt: string
}

export interface CreatorInput {
  name: string
  /** What the user typed: a link, @handle or name; empty to leave out. */
  links: Partial<Record<CreatorPlatform, string>>
  notify: boolean
}

export interface FeedItem {
  id: string
  title: string
  url: string
  publishedAt: string | null
  durationSeconds: number | null
  views: number | null
  /** Thumbnail as a data: URL, or null. */
  thumbnail: string | null
  /** Published since the profile's tab was last opened. */
  isNew: boolean
}

export interface CreatorFeed {
  platform: FeedPlatform
  items: FeedItem[]
  live: { title: string; viewers: number | null; url: string } | null
  avatar: string | null
  fetchedAt: string
  error: string | null
}

const PATTERNS: Record<CreatorPlatform, { hosts: string[]; path: RegExp; bare: RegExp; canonical: (name: string) => string }> = {
  // @handle, /channel/UC…, /c/name and /user/name all identify a channel.
  youtube: {
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
    path: /^\/(@[\w.-]{3,30}|channel\/UC[\w-]{22}|c\/[\w.-]{1,100}|user\/[\w.-]{1,100})\/?(?:videos|streams|shorts|featured)?\/?$/,
    bare: /^(@[\w.-]{3,30})$/,
    canonical: (name) => `https://www.youtube.com/${name}`
  },
  twitch: {
    hosts: ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'],
    path: /^\/([A-Za-z0-9_]{3,25})\/?(?:videos)?\/?$/,
    bare: /^([A-Za-z0-9_]{3,25})$/,
    canonical: (name) => `https://www.twitch.tv/${name.toLowerCase()}`
  },
  kick: {
    hosts: ['kick.com', 'www.kick.com'],
    path: /^\/([A-Za-z0-9_-]{2,30})\/?(?:videos)?\/?$/,
    bare: /^([A-Za-z0-9_-]{2,30})$/,
    canonical: (name) => `https://kick.com/${name.toLowerCase()}`
  },
  tiktok: {
    hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'],
    path: /^\/(@[\w.]{2,24})\/?$/,
    bare: /^(@[\w.]{2,24})$/,
    canonical: (name) => `https://www.tiktok.com/${name.toLowerCase()}`
  },
  instagram: {
    hosts: ['instagram.com', 'www.instagram.com'],
    path: /^\/([\w.]{1,30})\/?$/,
    bare: /^@?([\w.]{1,30})$/,
    canonical: (name) => `https://www.instagram.com/${name.toLowerCase()}`
  },
  x: {
    hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'],
    path: /^\/([A-Za-z0-9_]{1,15})\/?$/,
    bare: /^@?([A-Za-z0-9_]{1,15})$/,
    canonical: (name) => `https://x.com/${name}`
  }
}

/**
 * The canonical profile link for what the user typed (a profile link, an
 * @handle, or a bare name where the platform allows one), or null.
 */
export function creatorLink(platform: CreatorPlatform, value: string): string | null {
  const pattern = PATTERNS[platform]
  const text = value.trim()
  if (!text) return null
  const bare = pattern.bare.exec(text)
  if (bare && !text.includes('/')) return pattern.canonical(bare[1])
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
    if (!pattern.hosts.includes(url.hostname.toLowerCase())) return null
    const match = pattern.path.exec(url.pathname)
    return match ? pattern.canonical(match[1]) : null
  } catch {
    return null
  }
}

/** The account name inside a canonical link: @handle, a login or a slug. */
export function creatorAccount(link: string): string {
  try {
    return decodeURIComponent(new URL(link).pathname.split('/').filter(Boolean).join('/'))
  } catch {
    return link
  }
}

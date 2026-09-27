/** Twitch pages require the VOD extractor; other links retain direct-video support. */
export const TWITCH_VOD_HINT = 'Choose a public, completed Twitch VOD using its video link. Live channels, collections and Twitch clips are not supported.'
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv'])

export function twitchVodId(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!TWITCH_HOSTS.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
    return url.pathname.match(/^\/videos\/([0-9]+)\/?$/)?.[1] ?? null
  } catch { return null }
}

export function twitchSourceError(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return (host === 'twitch.tv' || host.endsWith('.twitch.tv')) && !twitchVodId(value) ? TWITCH_VOD_HINT : null
  } catch { return null }
}

export function normalizeVideoSource(value: string): string {
  const id = twitchVodId(value)
  if (id) return `https://www.twitch.tv/videos/${id}`
  const kick = kickVod(value)
  return kick ? `https://kick.com/${kick.channel}/videos/${kick.id}` : value.trim()
}

/** Kick saved broadcasts use the kick:vod extractor, which needs the channel/videos/<uuid> link. */
export const KICK_VOD_HINT = 'Choose a public, completed Kick VOD using its video link (kick.com/channel/videos/…). Live channels and Kick clips are not supported.'
const KICK_HOSTS = new Set(['kick.com', 'www.kick.com'])
const KICK_VOD_PATH = /^\/([A-Za-z0-9_-]+)\/videos\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/?$/i

export function kickVod(value: string): { channel: string; id: string } | null {
  try {
    const url = new URL(value.trim())
    if (!KICK_HOSTS.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
    const match = url.pathname.match(KICK_VOD_PATH)
    return match ? { channel: match[1].toLowerCase(), id: match[2].toLowerCase() } : null
  } catch { return null }
}

export function kickSourceError(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return (host === 'kick.com' || host.endsWith('.kick.com')) && !kickVod(value) ? KICK_VOD_HINT : null
  } catch { return null }
}

/** Why a link on a supported VOD platform can't be clipped, or null. */
export function vodSourceError(value: string): string | null {
  return twitchSourceError(value) ?? kickSourceError(value)
}

/** Video id for youtube.com/watch, youtu.be and /shorts links. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\.|^m\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1) || null
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v')
      const match = u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/)
      return match?.[2] ?? null
    }
  } catch {
    // not a URL
  }
  return null
}

/** What a link's platform says about the video before it is downloaded. */
export interface SourcePreviewInfo {
  title: string | null
  channel: string | null
  durationSeconds: number | null
  /** A data: URL, so the renderer needs no extra image hosts. */
  thumbnail: string | null
}

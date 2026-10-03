import { kickVod, twitchVodId, youtubeId, type SourcePreviewInfo } from '../shared/video-source'
import { createStreamSession, isStreamHost } from './stream-proxy'

/**
 * Title, duration and thumbnail for a YouTube, Twitch or Kick link, read from
 * each platform's public endpoints before the video is downloaded.
 *
 * Every request goes to a fixed host, redirects are refused, and responses are
 * size-capped. Thumbnails are returned as data: URLs so the renderer's CSP
 * needs no extra image hosts. Any failure yields a partial or null preview;
 * the preview is informational and never blocks a job.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const REQUEST_TIMEOUT_MS = 8000
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_PAGE_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024
const CACHE_TTL_MS = 10 * 60 * 1000
// Kick's Cloudflare rejects a full Chrome user agent from a non-browser TLS
// client; the generic token works for every endpoint used here.
const USER_AGENT = 'Mozilla/5.0'
// Twitch's public web client id, the same one its site and yt-dlp use.
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const THUMBNAIL_HOSTS = [
  /^i\.ytimg\.com$/,
  /^static-cdn\.jtvnw\.net$/,
  /^(images|files)\.kick\.com$/,
  /^kick-[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/
]

const cache = new Map<string, { at: number; value: Promise<SourcePreviewInfo | null> }>()

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('Response too large')
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error('Response too large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function request(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response
}

async function getJson(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await request(fetchImpl, url, { ...init, headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } })
  return JSON.parse(new TextDecoder().decode(await readCapped(response, MAX_JSON_BYTES)))
}

function isThumbnailUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && THUMBNAIL_HOSTS.some((host) => host.test(url.hostname))
  } catch {
    return false
  }
}

export async function fetchThumbnail(fetchImpl: FetchLike, url: unknown): Promise<string | null> {
  if (!isThumbnailUrl(url)) return null
  try {
    const response = await request(fetchImpl, url)
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!IMAGE_TYPES.has(type)) return null
    const bytes = await readCapped(response, MAX_IMAGE_BYTES)
    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    return null
  }
}

function text(value: unknown, max = 300): string | null {
  // Cut by code point so a limit never splits an emoji.
  return typeof value === 'string' && value.trim() ? Array.from(value.trim()).slice(0, max).join('') : null
}

function seconds(value: unknown, scale = 1): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number / scale : null
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Milliseconds since the epoch encoded in a UUIDv7, or null for other versions. */
export function uuidv7Millis(id: string): number | null {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id) || id[14] !== '7') return null
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}

/** Kick's "2026-09-23 03:31:33" start_time is UTC. */
function kickStartMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(`${value.trim().replace(' ', 'T')}Z`)
  return Number.isNaN(ms) ? null : ms
}

/** Sum of a finished media playlist's #EXTINF durations, or null if it isn't one. */
export function playlistSeconds(playlist: string): number | null {
  if (!/^#EXT-X-ENDLIST\s*$/m.test(playlist)) return null
  let total = 0
  for (const match of playlist.matchAll(/^#EXTINF:([^,\r\n]*)/gm)) {
    const value = Number(match[1])
    if (!Number.isFinite(value) || value <= 0) return null
    total += value
  }
  return total > 0 ? Math.round(total * 1000) / 1000 : null
}

/**
 * The playable length of a Kick VOD: its segments added up. Kick's API
 * reports the broadcast's wall-clock length, which also counts time the
 * stream was down, so after a restart it runs past the end of the video.
 * Every variant has the same segments, so the first one is enough.
 */
async function hlsSeconds(fetchImpl: FetchLike, masterUrl: string): Promise<number | null> {
  const headers = { Referer: 'https://kick.com/', Origin: 'https://kick.com' }
  const read = async (url: string): Promise<string> =>
    new TextDecoder().decode(await readCapped(await request(fetchImpl, url, { headers }), MAX_PLAYLIST_BYTES))
  try {
    const master = await read(masterUrl)
    if (/^#EXTINF:/m.test(master)) return playlistSeconds(master)
    const lines = master.split(/\r?\n/).map((line) => line.trim())
    const tag = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'))
    const uri = tag < 0 ? undefined : lines.slice(tag + 1).find((line) => line && !line.startsWith('#'))
    if (!uri) return null
    const variant = new URL(uri, masterUrl).href
    return isStreamHost(variant) ? playlistSeconds(await read(variant)) : null
  } catch {
    return null
  }
}

async function kickPreview(fetchImpl: FetchLike, channel: string, id: string): Promise<SourcePreviewInfo> {
  // Current links carry a UUIDv7 whose prefix is the VOD's start time, which
  // the video API doesn't know: find it in the channel's recent VODs instead.
  const startMs = uuidv7Millis(id)
  let stream: unknown
  // The HLS master playlist: on each listed VOD, at the top of the video API response.
  let source: unknown
  if (startMs != null) {
    const vods = await getJson(fetchImpl, `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}/videos`)
    let bestDelta = 5001
    for (const vod of Array.isArray(vods) ? vods : []) {
      const start = kickStartMillis(field(vod, 'start_time'))
      if (start != null && Math.abs(start - startMs) < bestDelta) {
        stream = vod
        bestDelta = Math.abs(start - startMs)
      }
    }
    if (!stream) throw new Error('Kick VOD not found')
    source = field(stream, 'source')
  } else {
    const video = await getJson(fetchImpl, `https://kick.com/api/v1/video/${id}`)
    stream = field(video, 'livestream')
    source = field(video, 'source')
  }
  const playback = typeof source === 'string' ? createStreamSession(source) : null
  const thumbnail = field(stream, 'thumbnail')
  const [playable, image] = await Promise.all([
    typeof source === 'string' && isStreamHost(source) ? hlsSeconds(fetchImpl, source) : null,
    // A URL on the video API, { src } on the channel listing.
    fetchThumbnail(fetchImpl, typeof thumbnail === 'string' ? thumbnail : field(thumbnail, 'src'))
  ])
  return {
    title: text(field(stream, 'session_title')),
    channel: text(field(stream, 'channel', 'slug'), 80) ?? channel,
    // The playable length matches the trim timeline the engine uses; Kick's
    // own figure (milliseconds) is the fallback.
    durationSeconds: playable ?? seconds(field(stream, 'duration'), 1000),
    thumbnail: image,
    stream: playback ? { kind: 'hls', url: playback } : null
  }
}

async function twitchPreview(fetchImpl: FetchLike, id: string): Promise<SourcePreviewInfo> {
  const data = await getJson(fetchImpl, 'https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($id: ID!) { video(id: $id) { title lengthSeconds previewThumbnailURL(width: 640, height: 360) owner { displayName } } }',
      variables: { id }
    })
  })
  const video = field(data, 'data', 'video')
  return {
    title: text(field(video, 'title')),
    channel: text(field(video, 'owner', 'displayName'), 80),
    durationSeconds: seconds(field(video, 'lengthSeconds')),
    thumbnail: await fetchThumbnail(fetchImpl, field(video, 'previewThumbnailURL')),
    stream: null
  }
}

async function youtubePreview(fetchImpl: FetchLike, id: string): Promise<SourcePreviewInfo> {
  const watch = `https://www.youtube.com/watch?v=${id}`
  const [oembed, duration, thumbnail] = await Promise.all([
    getJson(fetchImpl, `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`).catch(() => null),
    // The watch page is the only key-free source of the duration. A consent
    // redirect or a layout change just leaves the duration unknown.
    request(fetchImpl, watch, { headers: { 'Accept-Language': 'en' } })
      .then((response) => readCapped(response, MAX_PAGE_BYTES))
      .then((bytes) => seconds(new TextDecoder().decode(bytes).match(/"lengthSeconds":"(\d+)"/)?.[1]))
      .catch(() => null),
    fetchThumbnail(fetchImpl, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`)
  ])
  return {
    title: text(field(oembed, 'title')),
    channel: text(field(oembed, 'author_name'), 80),
    durationSeconds: duration,
    thumbnail,
    stream: { kind: 'youtube', id }
  }
}

async function loadPreview(fetchImpl: FetchLike, source: string): Promise<SourcePreviewInfo | null> {
  const kick = kickVod(source)
  if (kick) return kickPreview(fetchImpl, kick.channel, kick.id)
  const twitch = twitchVodId(source)
  if (twitch) return twitchPreview(fetchImpl, twitch)
  const youtube = youtubeId(source)
  if (youtube && /^[A-Za-z0-9_-]{11}$/.test(youtube)) return youtubePreview(fetchImpl, youtube)
  return null
}

/** Preview for a supported link, or null for other sources and on failure. */
export function getSourcePreview(fetchImpl: FetchLike, source: string): Promise<SourcePreviewInfo | null> {
  const now = Date.now()
  for (const [key, entry] of cache) if (now - entry.at > CACHE_TTL_MS) cache.delete(key)
  const cached = cache.get(source)
  if (cached) return cached.value
  const value = loadPreview(fetchImpl, source).catch(() => null)
  cache.set(source, { at: now, value })
  // Retry a failed preview next time instead of caching the failure.
  void value.then((result) => { if (!result) cache.delete(source) })
  return value
}

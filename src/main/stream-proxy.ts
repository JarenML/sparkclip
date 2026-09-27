import { randomBytes } from 'crypto'

/**
 * Plays a remote HLS stream (a Kick VOD) in the renderer for the source
 * preview. The stream's servers send no CORS headers, so the renderer can't
 * load it directly; this serves it through the privileged stream-proxy://
 * scheme instead.
 *
 * Each preview gets a random session token. Playlists are fetched here and
 * rewritten so every URI points back at the proxy, and the proxy only fetches
 * URLs it wrote into a playlist for that session: the renderer can never make
 * the main process fetch an arbitrary address. The master playlist keeps only
 * low-resolution variants, since the preview doesn't need the full quality.
 */

export const STREAM_PROXY_SCHEME = 'stream-proxy'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Upstream hosts a preview stream may come from. */
const STREAM_HOSTS = [/^stream\.kick\.com$/]
/** Variants above this height are dropped from the master playlist. */
const MAX_PREVIEW_HEIGHT = 480
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024
const SESSION_TTL_MS = 60 * 60 * 1000
const MAX_SESSIONS = 20
const REQUEST_TIMEOUT_MS = 20000
const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl'

interface Session {
  expires: number
  /** Upstream URLs the proxy has handed out, by their proxy path id. */
  urls: Map<string, string>
}

const sessions = new Map<string, Session>()

export function isStreamHost(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && STREAM_HOSTS.some((host) => host.test(url.hostname))
  } catch {
    return false
  }
}

function pathId(upstream: string): string {
  return Buffer.from(upstream).toString('base64url')
}

function proxyUrl(token: string, id: string): string {
  return `${STREAM_PROXY_SCHEME}://hls/${token}/${id}`
}

/** Starts a preview session for an HLS master playlist; returns the URL the renderer plays. */
export function createStreamSession(masterUrl: string, now = Date.now()): string | null {
  if (!isStreamHost(masterUrl)) return null
  for (const [token, session] of sessions) if (session.expires < now) sessions.delete(token)
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string)
  const token = randomBytes(16).toString('hex')
  const id = pathId(masterUrl)
  sessions.set(token, { expires: now + SESSION_TTL_MS, urls: new Map([[id, masterUrl]]) })
  return proxyUrl(token, id)
}

function variantHeight(tag: string): number | null {
  const match = /RESOLUTION=\d+x(\d+)/i.exec(tag)
  return match ? Number(match[1]) : null
}

/**
 * Keeps only the master playlist's variants at or below the preview height
 * (or the smallest one when every variant is larger).
 */
export function limitVariants(playlist: string, maxHeight = MAX_PREVIEW_HEIGHT): string {
  const lines = playlist.split(/\r?\n/)
  const variants: { index: number; height: number }[] = []
  lines.forEach((line, index) => {
    if (line.startsWith('#EXT-X-STREAM-INF')) variants.push({ index, height: variantHeight(line) ?? 0 })
  })
  if (variants.length === 0) return playlist
  const keep = variants.filter((variant) => variant.height <= maxHeight)
  const kept = new Set((keep.length > 0 ? keep : [variants.reduce((a, b) => (b.height < a.height ? b : a))]).map((v) => v.index))
  const drop = new Set<number>()
  for (const variant of variants) {
    if (kept.has(variant.index)) continue
    drop.add(variant.index)
    // The variant's URI is the next non-empty, non-tag line.
    for (let i = variant.index + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      if (!lines[i].startsWith('#')) drop.add(i)
      break
    }
  }
  return lines.filter((_, index) => !drop.has(index)).join('\n')
}

/**
 * Rewrites every URI in a playlist (plain URI lines and URI="…" attributes)
 * to a proxy URL for this session. URIs outside the allowed stream hosts are
 * removed. Returns the rewritten playlist and the upstream URLs it points at.
 */
export function rewritePlaylist(playlist: string, playlistUrl: string, token: string): { text: string; urls: Map<string, string> } {
  const urls = new Map<string, string>()
  const map = (uri: string): string | null => {
    let absolute: string
    try {
      absolute = new URL(uri, playlistUrl).href
    } catch {
      return null
    }
    if (!isStreamHost(absolute)) return null
    const id = pathId(absolute)
    urls.set(id, absolute)
    return proxyUrl(token, id)
  }
  const out: string[] = []
  for (const line of playlist.split(/\r?\n/)) {
    if (!line.trim()) {
      out.push(line)
    } else if (line.startsWith('#')) {
      let dropped = false
      const tag = line.replace(/URI="([^"]*)"/g, (_, uri: string) => {
        const mapped = map(uri)
        if (!mapped) dropped = true
        return `URI="${mapped ?? ''}"`
      })
      if (!dropped) out.push(tag)
    } else {
      const mapped = map(line.trim())
      if (mapped) out.push(mapped)
    }
  }
  return { text: out.join('\n'), urls }
}

function isPlaylist(url: string, contentType: string): boolean {
  return /mpegurl/i.test(contentType) || new URL(url).pathname.toLowerCase().endsWith('.m3u8')
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('Playlist too large')
  const text = await response.text()
  if (text.length > limit) throw new Error('Playlist too large')
  return text
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

/** Handles one stream-proxy:// request. */
export async function handleStreamRequest(fetchImpl: FetchLike, request: Request, now = Date.now()): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: CORS })
  const match = /^stream-proxy:\/\/hls\/([0-9a-f]{32})\/([A-Za-z0-9_-]{1,4096})$/.exec(request.url)
  const session = match ? sessions.get(match[1]) : undefined
  const upstream = match && session && session.expires >= now ? session.urls.get(match[2]) : undefined
  if (!match || !session || !upstream) return new Response('Not found', { status: 404, headers: CORS })
  try {
    const response = await fetchImpl(upstream, {
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Referer: 'https://kick.com/', Origin: 'https://kick.com', 'User-Agent': 'Mozilla/5.0' }
    })
    if (!response.ok) return new Response(null, { status: response.status === 404 ? 404 : 502, headers: CORS })
    const contentType = response.headers.get('content-type') ?? ''
    if (isPlaylist(upstream, contentType)) {
      const text = limitVariants(await readCapped(response, MAX_PLAYLIST_BYTES))
      const rewritten = rewritePlaylist(text, upstream, match[1])
      for (const [id, url] of rewritten.urls) session.urls.set(id, url)
      return new Response(rewritten.text, { status: 200, headers: { ...CORS, 'Content-Type': PLAYLIST_TYPE } })
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_SEGMENT_BYTES) return new Response(null, { status: 502, headers: CORS })
    return new Response(response.body, {
      status: 200,
      headers: { ...CORS, 'Content-Type': /^video\/|^audio\//i.test(contentType) ? contentType : 'video/mp2t' }
    })
  } catch {
    return new Response(null, { status: 502, headers: CORS })
  }
}

/** Test hook: forget every session. */
export function clearStreamSessions(): void {
  sessions.clear()
}

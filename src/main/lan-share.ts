import { randomBytes, timingSafeEqual } from 'crypto'
import { createReadStream, lstatSync, realpathSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { extname, isAbsolute, relative } from 'path'
import { fileURLToPath } from 'url'
import type { JobOutput } from '../shared/job-output'
import type { LanShare } from '../shared/lan-share'

/**
 * Shares one run's clips with phones on the same network: a small read-only
 * HTTP server on a random port, reachable only through a link that carries a
 * random token. It serves a page listing the clips and the clip files
 * themselves (with byte ranges, so phones can seek), and nothing else. One
 * run is shared at a time; it stops on request, after SHARE_LIFETIME_MS, or
 * when the app quits.
 */

interface SharedClip {
  title: string
  durationMs: number
  score: number
  path: string
  size: number
}

const SHARE_LIFETIME_MS = 2 * 60 * 60 * 1000
const TOKEN_BYTES = 16

let active: { share: LanShare; server: Server; timer: NodeJS.Timeout } | null = null

/**
 * IPv4 addresses on private networks, which phones on the same network can
 * reach, most likely first: home routers use 192.168.x.x, while 172.16-31.x.x
 * is also where Docker, WSL and Hyper-V put their virtual adapters.
 */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const ranked: { address: string; rank: number }[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const [a, b] = entry.address.split('.').map(Number)
      const rank = a === 192 && b === 168 ? 0 : a === 10 ? 1 : a === 172 && b >= 16 && b <= 31 ? 2 : -1
      if (rank >= 0) ranked.push({ address: entry.address, rank })
    }
  }
  return ranked.sort((x, y) => x.rank - y.rank).map((entry) => entry.address)
}

/** The run's clip files, checked to be MP4 files inside the run folder. */
export function sharedClips(output: JobOutput, runDir: string): SharedClip[] {
  const root = realpathSync(runDir)
  const clips: SharedClip[] = []
  for (const clip of [...output.clips].sort((a, b) => b.virality_score - a.virality_score)) {
    try {
      const path = realpathSync(fileURLToPath(clip.s3_url))
      const rel = relative(root, path)
      const entry = lstatSync(path)
      if (isAbsolute(rel) || rel.startsWith('..') || extname(path).toLowerCase() !== '.mp4' || !entry.isFile()) continue
      clips.push({ title: clip.summary || `Clip ${clip.clip_index + 1}`, durationMs: clip.duration_ms, score: clip.virality_score, path, size: entry.size })
    } catch { /* A clip file that's gone isn't shared. */ }
  }
  return clips
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function sharePage(title: string, clips: SharedClip[]): string {
  const items = clips.map((clip, i) => `
    <li>
      <video controls playsinline preload="metadata" src="clips/${i}.mp4"></video>
      <div class="row"><strong>${escapeHtml(clip.title)}</strong><span>${duration(clip.durationMs)} · ${(clip.score * 10).toFixed(1)}</span></div>
      <a href="clips/${i}.mp4?download=1" download>Download</a>
    </li>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · SparkClip</title>
<style>
  body { margin: 0; padding: 16px; background: #0b0b0f; color: #ececf1; font: 15px/1.4 system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; } p { margin: 0 0 16px; color: #9a9aa6; font-size: 13px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 20px; }
  video { width: 100%; max-height: 80vh; background: #000; border-radius: 12px; }
  .row { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; }
  .row span { color: #9a9aa6; white-space: nowrap; font-variant-numeric: tabular-nums; }
  a { color: #7aa2ff; font-size: 14px; }
</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${clips.length} clip${clips.length === 1 ? '' : 's'}, best first · shared from SparkClip on this network</p>
<ul>${items}</ul></body></html>`
}

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
}

function send(res: ServerResponse, status: number, body = '', headers: Record<string, string | number> = {}): void {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}

function sendClip(req: IncomingMessage, res: ServerResponse, clip: SharedClip, download: boolean): void {
  const headers: Record<string, string | number> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${clip.title.replace(/[^\w .()-]+/g, '').trim().slice(0, 80) || 'clip'}.mp4"; filename*=UTF-8''${encodeURIComponent(`${clip.title.slice(0, 80)}.mp4`)}`
  }
  let start = 0
  let end = clip.size - 1
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match || (!match[1] && !match[2])) return send(res, 416, '', { 'Content-Range': `bytes */${clip.size}` })
    if (match[1]) {
      start = Number(match[1])
      if (match[2]) end = Math.min(Number(match[2]), clip.size - 1)
    } else {
      start = Math.max(0, clip.size - Number(match[2]))
    }
    if (start > end || start >= clip.size) return send(res, 416, '', { 'Content-Range': `bytes */${clip.size}` })
    headers['Content-Range'] = `bytes ${start}-${end}/${clip.size}`
  }
  res.writeHead(range ? 206 : 200, { ...HEADERS, ...headers, 'Content-Length': end - start + 1 })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(clip.path, { start, end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/** Request handler for one share: everything lives under /<token>/. */
export function shareHandler(token: string, title: string, clips: SharedClip[]) {
  const expected = Buffer.from(token)
  const page = sharePage(title, clips)
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://share.invalid') } catch { return send(res, 400, 'Bad request') }
    const [, given, ...rest] = url.pathname.split('/')
    const supplied = Buffer.from(given ?? '')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(res, 404, 'Not found')
    const path = rest.join('/')
    if (path === '') {
      return send(res, 200, req.method === 'HEAD' ? '' : page, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      })
    }
    const clipMatch = /^clips\/(\d{1,4})\.mp4$/.exec(path)
    const clip = clipMatch ? clips[Number(clipMatch[1])] : undefined
    if (!clip) return send(res, 404, 'Not found')
    sendClip(req, res, clip, url.searchParams.get('download') === '1')
  }
}

/** Starts sharing a run (replacing any other share) and returns the links to open on a phone. */
export async function startShare(outputDir: string, output: JobOutput, now = Date.now()): Promise<LanShare> {
  stopShare()
  const addresses = lanAddresses()
  if (addresses.length === 0) throw new Error('Connect this computer to a Wi-Fi or wired network first.')
  const clips = sharedClips(output, outputDir)
  if (clips.length === 0) throw new Error('This run has no clips to share.')
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const server = createServer(shareHandler(token, output.source_video_title || 'SparkClip clips', clips))
  server.requestTimeout = 60_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => { server.off('error', reject); resolve() })
  })
  const { port } = server.address() as { port: number }
  const share: LanShare = {
    outputDir,
    urls: addresses.map((address) => `http://${address}:${port}/${token}/`),
    expiresAt: new Date(now + SHARE_LIFETIME_MS).toISOString()
  }
  const timer = setTimeout(stopShare, SHARE_LIFETIME_MS)
  timer.unref()
  active = { share, server, timer }
  return share
}

export function stopShare(): void {
  if (!active) return
  clearTimeout(active.timer)
  active.server.close()
  active.server.closeAllConnections()
  active = null
}

export function currentShare(): LanShare | null {
  return active?.share ?? null
}

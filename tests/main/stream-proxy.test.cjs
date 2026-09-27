const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')

function load() {
  const file = path.resolve(__dirname, '../../src/main/stream-proxy.ts')
  const { outputFiles } = esbuild.buildSync({ entryPoints: [file], bundle: true, format: 'cjs', platform: 'node', write: false })
  const mod = new Module(file)
  mod._compile(outputFiles[0].text, file)
  return mod.exports
}

const BASE = 'https://stream.kick.com/abc/ivs/v1/1/X/2026/9/23/3/31/Y/media/hls/'
const MASTER = `${BASE}master.m3u8`
const MASTER_TEXT = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=8767269,RESOLUTION=1920x1080',
  '1080p60/playlist.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3331932,RESOLUTION=1280x720',
  '720p60/playlist.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1336932,RESOLUTION=852x480',
  '480p30/playlist.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=630000,RESOLUTION=640x360',
  '360p30/playlist.m3u8'
].join('\n')
const VARIANT_TEXT = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:12.5,', '0.ts', '#EXTINF:12.5,', 'https://evil.test/1.ts', '#EXTINF:12.5,', '2.ts', '#EXT-X-ENDLIST'].join('\n')

function upstream(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const body = routes[url]
    if (body === undefined) return new Response('missing', { status: 404 })
    const playlist = url.endsWith('.m3u8')
    return new Response(body, { headers: { 'content-type': playlist ? 'application/x-mpegURL' : 'video/MP2T' } })
  }
  return { fetchImpl, calls }
}

const get = (url, method = 'GET') => new Request(url, { method })

test('the master playlist keeps only variants up to 480p', () => {
  const { limitVariants } = load()
  const limited = limitVariants(MASTER_TEXT)
  assert.doesNotMatch(limited, /1080p60|720p60/)
  assert.match(limited, /480p30\/playlist\.m3u8/)
  assert.match(limited, /360p30\/playlist\.m3u8/)
  // All variants too large: keep the smallest.
  const large = limitVariants(['#EXTM3U', '#EXT-X-STREAM-INF:RESOLUTION=1920x1080', 'a.m3u8', '#EXT-X-STREAM-INF:RESOLUTION=1280x720', 'b.m3u8'].join('\n'))
  assert.doesNotMatch(large, /a\.m3u8/)
  assert.match(large, /b\.m3u8/)
})

test('playlists are rewritten to proxy URLs and foreign hosts are dropped', () => {
  const { rewritePlaylist } = load()
  const { text, urls } = rewritePlaylist(VARIANT_TEXT, `${BASE}480p30/playlist.m3u8`, 'a'.repeat(32))
  assert.doesNotMatch(text, /https:\/\/|evil/)
  assert.equal(text.match(/stream-proxy:\/\/hls\//g).length, 3) // init map + two segments
  assert.deepEqual([...urls.values()].sort(), [`${BASE}480p30/0.ts`, `${BASE}480p30/2.ts`, `${BASE}480p30/init.mp4`])
})

test('sessions only start for Kick stream hosts', () => {
  const { createStreamSession } = load()
  assert.match(createStreamSession(MASTER), /^stream-proxy:\/\/hls\/[0-9a-f]{32}\/[A-Za-z0-9_-]+$/)
  for (const url of ['https://evil.test/master.m3u8', 'http://stream.kick.com/master.m3u8', 'https://stream.kick.com:8443/m.m3u8', 'https://u:p@stream.kick.com/m.m3u8', 'not a url']) {
    assert.equal(createStreamSession(url), null)
  }
})

test('the proxy serves the session playlist chain and nothing else', async () => {
  const { createStreamSession, handleStreamRequest } = load()
  const { fetchImpl, calls } = upstream({
    [MASTER]: MASTER_TEXT,
    [`${BASE}480p30/playlist.m3u8`]: VARIANT_TEXT,
    [`${BASE}480p30/0.ts`]: 'segment-bytes'
  })
  const entry = createStreamSession(MASTER)
  const master = await handleStreamRequest(fetchImpl, get(entry))
  assert.equal(master.status, 200)
  assert.equal(master.headers.get('content-type'), 'application/vnd.apple.mpegurl')
  assert.equal(master.headers.get('access-control-allow-origin'), '*')
  const masterText = await master.text()
  assert.doesNotMatch(masterText, /1080p60|https:\/\//)
  assert.equal(calls[0].init.redirect, 'error')

  const variantUrl = masterText.split('\n').find((line) => line.startsWith('stream-proxy://') && calls.length === 1)
  const variant = await (await handleStreamRequest(fetchImpl, get(variantUrl))).text()
  const segmentUrl = variant.split('\n').find((line) => line.startsWith('stream-proxy://') && !line.includes('URI='))
  const segment = await handleStreamRequest(fetchImpl, get(segmentUrl))
  assert.equal(segment.status, 200)
  assert.equal(segment.headers.get('content-type'), 'video/MP2T')
  assert.equal(await segment.text(), 'segment-bytes')

  // A URL the proxy never handed out, an unknown token, and other methods are refused.
  const token = entry.split('/')[3]
  const forged = `stream-proxy://hls/${token}/${Buffer.from('https://stream.kick.com/other.ts').toString('base64url')}`
  const before = calls.length
  assert.equal((await handleStreamRequest(fetchImpl, get(forged))).status, 404)
  assert.equal((await handleStreamRequest(fetchImpl, get(`stream-proxy://hls/${'0'.repeat(32)}/${entry.split('/')[4]}`))).status, 404)
  assert.equal((await handleStreamRequest(fetchImpl, get(entry, 'POST'))).status, 405)
  assert.equal(calls.length, before)
})

test('expired sessions and upstream failures do not leak details', async () => {
  const { createStreamSession, handleStreamRequest } = load()
  const entry = createStreamSession(MASTER, 0)
  const { fetchImpl } = upstream({})
  assert.equal((await handleStreamRequest(fetchImpl, get(entry), 2 * 60 * 60 * 1000)).status, 404)
  const live = createStreamSession(MASTER)
  const failed = await handleStreamRequest(async () => { throw new Error('secret https://x') }, get(live))
  assert.equal(failed.status, 502)
  assert.equal(await failed.text(), '')
})

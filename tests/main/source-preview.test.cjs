const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')

function load() {
  const file = path.resolve(__dirname, '../../src/main/source-preview.ts')
  const { outputFiles } = esbuild.buildSync({ entryPoints: [file], bundle: true, format: 'cjs', platform: 'node', write: false })
  const mod = new Module(file)
  mod._compile(outputFiles[0].text, file)
  return mod.exports
}

const KICK_ID = '191061c4-3c2e-46e8-83ef-eca789c89b3c'
const KICK_URL = `https://kick.com/elzeein/videos/${KICK_ID}`
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function image(bytes = JPEG, type = 'image/jpeg') {
  return new Response(bytes, { headers: { 'content-type': type } })
}

/** A fetch that serves fixed routes and records every request. */
function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (!route) throw new Error(`unexpected request ${url}`)
    return route[1](url, init)
  }
  return { fetchImpl, calls }
}

test('Kick previews read the title, channel, millisecond duration and thumbnail', async () => {
  const { getSourcePreview } = load()
  const { fetchImpl, calls } = fakeFetch({
    [`https://kick.com/api/v1/video/${KICK_ID}`]: () => json({ livestream: { session_title: ' Saved stream ', duration: 6096000, thumbnail: 'https://kick-prod-videos-30-day.s3.us-west-2.amazonaws.com/t.jpg?X-Amz-Signature=x', channel: { slug: 'elzeein' } } }),
    'https://kick-prod-videos-30-day.s3.us-west-2.amazonaws.com/': () => image()
  })
  const preview = await getSourcePreview(fetchImpl, KICK_URL)
  assert.deepEqual({ ...preview, thumbnail: preview.thumbnail.slice(0, 23) }, { title: 'Saved stream', channel: 'elzeein', durationSeconds: 6096, thumbnail: 'data:image/jpeg;base64,' })
  for (const call of calls) assert.equal(call.init.redirect, 'error')
})

test('Twitch previews use the public GQL video query', async () => {
  const { getSourcePreview } = load()
  const { fetchImpl, calls } = fakeFetch({
    'https://gql.twitch.tv/gql': () => json({ data: { video: { title: 'VOD', lengthSeconds: 3600, previewThumbnailURL: 'https://static-cdn.jtvnw.net/cf_vods/x/thumb0-640x360.jpg', owner: { displayName: 'Streamer' } } } }),
    'https://static-cdn.jtvnw.net/': () => image()
  })
  const preview = await getSourcePreview(fetchImpl, 'https://www.twitch.tv/videos/12345')
  assert.equal(preview.title, 'VOD')
  assert.equal(preview.durationSeconds, 3600)
  assert.equal(preview.channel, 'Streamer')
  assert.match(preview.thumbnail, /^data:image\/jpeg;base64,/)
  assert.equal(JSON.parse(calls[0].init.body).variables.id, '12345')
})

test('YouTube previews combine oEmbed, the watch page duration and the ytimg thumbnail', async () => {
  const { getSourcePreview } = load()
  const { fetchImpl } = fakeFetch({
    'https://www.youtube.com/oembed': () => json({ title: 'Talk', author_name: 'Channel' }),
    'https://www.youtube.com/watch': () => new Response('<html>"lengthSeconds":"213"</html>'),
    'https://i.ytimg.com/': () => image()
  })
  const preview = await getSourcePreview(fetchImpl, 'https://youtu.be/dQw4w9WgXcQ')
  assert.deepEqual([preview.title, preview.channel, preview.durationSeconds], ['Talk', 'Channel', 213])
  assert.match(preview.thumbnail, /^data:image\/jpeg;base64,/)
})

test('thumbnails only load from known image hosts, as images, within the size cap', async () => {
  const { fetchThumbnail } = load()
  const { fetchImpl, calls } = fakeFetch({ 'https://static-cdn.jtvnw.net/big': () => image(Buffer.alloc(3 * 1024 * 1024)), 'https://static-cdn.jtvnw.net/html': () => image(Buffer.from('<html>'), 'text/html') })
  for (const url of ['https://evil.test/a.jpg', 'http://static-cdn.jtvnw.net/a.jpg', 'https://user:pw@static-cdn.jtvnw.net/a.jpg', 'https://kick.com.evil.test/a.jpg', 'https://other-bucket.s3.us-west-2.amazonaws.com/a.jpg', null]) {
    assert.equal(await fetchThumbnail(fetchImpl, url), null)
  }
  assert.equal(calls.length, 0)
  assert.equal(await fetchThumbnail(fetchImpl, 'https://static-cdn.jtvnw.net/big.jpg'), null)
  assert.equal(await fetchThumbnail(fetchImpl, 'https://static-cdn.jtvnw.net/html.jpg'), null)
})

test('unsupported sources and failed requests give no preview, and failures are not cached', async () => {
  const { getSourcePreview } = load()
  let fail = true
  const { fetchImpl, calls } = fakeFetch({
    [`https://kick.com/api/v1/video/${KICK_ID}`]: () => (fail ? new Response('blocked', { status: 403 }) : json({ livestream: { session_title: 'Back' } }))
  })
  assert.equal(await getSourcePreview(fetchImpl, 'https://example.com/video.mp4'), null)
  assert.equal(await getSourcePreview(fetchImpl, 'C:\\videos\\local.mp4'), null)
  assert.equal(await getSourcePreview(fetchImpl, KICK_URL), null)
  fail = false
  assert.equal((await getSourcePreview(fetchImpl, KICK_URL)).title, 'Back')
  assert.equal(calls.length, 2)
})

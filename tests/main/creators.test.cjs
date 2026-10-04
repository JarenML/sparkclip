'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

function load(dir) {
  const electron = fakeElectron(dir).electron
  return loadMain("export * from './src/main/creators'; export * as links from './src/shared/creators'; export { isCreatorVideoUrl } from './src/main/ipc-handlers'", {
    electron: { ...electron, Notification: class { static isSupported() { return false } } }
  })
}

const rss = (entries) => `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">${entries.map(([id, title, published]) => `
  <entry><yt:videoId>${id}</yt:videoId><title>${title}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
  <published>${published}</published><media:group><media:thumbnail url="https://i4.ytimg.com/vi/${id}/hqdefault.jpg" width="480" height="360"/>
  <media:community><media:statistics views="1234"/></media:community></media:group></entry>`).join('')}</feed>`

/** A fetch that serves routes by URL prefix and records each request. */
function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (!route) throw new Error(`unexpected ${url}`)
    return route[1](url, init)
  }
  return { fetchImpl, calls }
}
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const image = () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })

test('profile links are accepted as links, @handles or names and stored canonically', () => {
  const { links } = load(tempDir().dir)
  const cases = [
    ['youtube', 'https://www.youtube.com/@IShowSpeed/videos', 'https://www.youtube.com/@IShowSpeed'],
    ['youtube', '@IShowSpeed', 'https://www.youtube.com/@IShowSpeed'],
    ['youtube', 'youtube.com/channel/UCWsDFcIhY2DBi3GB5uykGXA', 'https://www.youtube.com/channel/UCWsDFcIhY2DBi3GB5uykGXA'],
    ['twitch', 'https://www.twitch.tv/IShowSpeed', 'https://www.twitch.tv/ishowspeed'],
    ['twitch', 'ishowspeed', 'https://www.twitch.tv/ishowspeed'],
    ['kick', 'https://kick.com/sachauzumaki/videos', 'https://kick.com/sachauzumaki'],
    ['tiktok', '@ishowspeed', 'https://www.tiktok.com/@ishowspeed'],
    ['instagram', 'instagram.com/ishowspeed', 'https://www.instagram.com/ishowspeed'],
    ['x', 'https://twitter.com/ishowspeedsui', 'https://x.com/ishowspeedsui']
  ]
  for (const [platform, input, expected] of cases) assert.equal(links.creatorLink(platform, input), expected, input)
  for (const [platform, input] of [['youtube', 'IShowSpeed'], ['youtube', 'https://evil.example/@x'], ['twitch', 'https://www.twitch.tv/videos/123'.replace('videos/123', 'a/b/c')], ['kick', 'https://kick.com.evil.test/x'], ['x', 'https://x.com/a/status/1'], ['twitch', 'http://user:pw@twitch.tv/a']]) {
    assert.equal(links.creatorLink(platform, input), null, input)
  }
})

test('creators are saved, edited, validated and removed', () => {
  const { dir, cleanup } = tempDir()
  try {
    const api = load(dir)
    assert.throws(() => api.saveCreator({ name: '', links: { twitch: 'speed' }, notify: false }), /name/)
    assert.throws(() => api.saveCreator({ name: 'Speed', links: {}, notify: false }), /at least one/)
    assert.throws(() => api.saveCreator({ name: 'Speed', links: { youtube: 'not a channel' }, notify: false }), /YouTube profile/)
    const speed = api.saveCreator({ name: '  IShowSpeed ', links: { twitch: 'IShowSpeed', youtube: '@IShowSpeed', x: '' }, notify: true })
    assert.deepEqual(speed.links, { youtube: 'https://www.youtube.com/@IShowSpeed', twitch: 'https://www.twitch.tv/ishowspeed' })
    api.saveCreator({ name: 'Braeden', links: { kick: 'braeden' }, notify: false })
    assert.deepEqual(api.listCreators().map((c) => c.name), ['Braeden', 'IShowSpeed'])
    const edited = api.saveCreator({ name: 'Speed', links: { kick: 'speed' }, notify: false }, speed.id)
    assert.equal(edited.id, speed.id)
    assert.deepEqual(edited.links, { kick: 'https://kick.com/speed' })
    assert.equal(api.setCreatorNotify(speed.id, true).notify, true)
    assert.equal(api.creatorProfileLink(speed.id, 'kick'), 'https://kick.com/speed')
    // A fresh load reads the same creators back from disk.
    api.resetCreatorsForTests()
    assert.equal(api.listCreators().length, 2)
    assert.equal(api.deleteCreator(speed.id), true)
    assert.equal(api.deleteCreator(speed.id), false)
    assert.deepEqual(api.listCreators().map((c) => c.name), ['Braeden'])
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'userData', 'creators.json'), 'utf8'))
    assert.equal(stored.creators.length, 1)
  } finally { cleanup() }
})

test('YouTube, Twitch and Kick feeds list recent videos, thumbnails and live streams', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const api = load(dir)
    const creator = api.saveCreator({ name: 'Speed', links: { youtube: '@IShowSpeed', twitch: 'ishowspeed', kick: 'speed' }, notify: false })
    let kickFailures = 1
    const { fetchImpl, calls } = fakeFetch({
      'https://www.youtube.com/@IShowSpeed': () => new Response('<html>"externalId":"UCWsDFcIhY2DBi3GB5uykGXA" <meta property="og:image" content="https://yt3.googleusercontent.com/avatar=s900"></html>'),
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCWsDFcIhY2DBi3GB5uykGXA': () => new Response(rss([['SOW3qCJJSlQ', 'RONALDO RETIRED??? &amp; more', '2026-10-03T20:28:16+00:00'], ['ZmCbmzwQF98', 'Gets A Job at KFC!', '2026-09-27T23:11:52+00:00']])),
      'https://gql.twitch.tv/gql': () => json({ data: { user: { profileImageURL: 'https://static-cdn.jtvnw.net/p.png', stream: { title: 'IRL', viewersCount: 52000 },
        videos: { edges: [{ node: { id: '2890898173', title: 'VOD', publishedAt: '2026-10-03T17:11:49Z', lengthSeconds: 11122, viewCount: 3568, previewThumbnailURL: 'https://static-cdn.jtvnw.net/t.jpg' } }] } } } }),
      'https://kick.com/api/v2/channels/speed/videos': () => json([{ session_title: 'Kick VOD', start_time: '2026-09-23 03:31:33', duration: 3600000, views: 10, thumbnail: { src: 'https://images.kick.com/t.webp' }, video: { uuid: '9d0925d9-4a6b-4e10-84f5-9ee9e5bdcd21' } }]),
      'https://kick.com/api/v2/channels/speed': () => (kickFailures-- > 0 ? new Response('busy', { status: 429 }) : json({ livestream: null, user: { profile_pic: 'https://files.kick.com/p.webp' } })),
      'https://i4.ytimg.com/': image, 'https://yt3.googleusercontent.com/': image, 'https://static-cdn.jtvnw.net/': image, 'https://images.kick.com/': image, 'https://files.kick.com/': image
    })

    const youtube = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube')
    assert.equal(youtube.error, null)
    assert.deepEqual(youtube.items.map((i) => [i.id, i.title, i.url, i.views]), [
      ['SOW3qCJJSlQ', 'RONALDO RETIRED??? & more', 'https://www.youtube.com/watch?v=SOW3qCJJSlQ', 1234],
      ['ZmCbmzwQF98', 'Gets A Job at KFC!', 'https://www.youtube.com/watch?v=ZmCbmzwQF98', 1234]
    ])
    assert.match(youtube.items[0].thumbnail, /^data:image\/jpeg;base64,/)
    assert.match(youtube.avatar, /^data:image\/jpeg;base64,/)
    // The channel page is read once; later feeds go straight to the channel's feed.
    await api.getCreatorFeed(fetchImpl, creator.id, 'youtube', true)
    assert.equal(calls.filter((c) => c.url === 'https://www.youtube.com/@IShowSpeed').length, 1)

    const twitch = await api.getCreatorFeed(fetchImpl, creator.id, 'twitch')
    assert.deepEqual(twitch.items.map((i) => [i.url, i.durationSeconds, i.views]), [['https://www.twitch.tv/videos/2890898173', 11122, 3568]])
    assert.deepEqual(twitch.live, { title: 'IRL', viewers: 52000, url: 'https://www.twitch.tv/ishowspeed' })
    assert.match(JSON.parse(calls.find((c) => c.url === 'https://gql.twitch.tv/gql').init.body).variables.login, /^ishowspeed$/)

    const kick = await api.getCreatorFeed(fetchImpl, creator.id, 'kick')
    assert.equal(kick.error, null)
    assert.deepEqual(kick.items.map((i) => [i.url, i.publishedAt, i.durationSeconds]), [['https://kick.com/speed/videos/9d0925d9-4a6b-4e10-84f5-9ee9e5bdcd21', '2026-09-23T03:31:33.000Z', 3600]])
    for (const call of calls) assert.equal(call.init.redirect, 'error')

    await assert.rejects(api.getCreatorFeed(fetchImpl, creator.id, 'tiktok'), /Unsupported/)
    const broken = await api.getCreatorFeed(async () => { throw new Error('offline') }, creator.id, 'youtube', true)
    assert.match(broken.error, /Couldn't load YouTube/)
    assert.equal(broken.items.length, 2, 'the last good list stays visible')
  } finally { cleanup() }
})

test('uploads after the tab was last opened are new', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const api = load(dir)
    const creator = api.saveCreator({ name: 'Speed', links: { youtube: 'youtube.com/channel/UCWsDFcIhY2DBi3GB5uykGXA' }, notify: false })
    const { fetchImpl } = fakeFetch({
      'https://www.youtube.com/feeds/': () => new Response(rss([['SOW3qCJJSlQ', 'Today', new Date(Date.now() + 60_000).toISOString()], ['ZmCbmzwQF98', 'Last week', '2026-09-27T23:11:52+00:00']])),
      'https://i4.ytimg.com/': image
    })
    let feed = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube')
    assert.deepEqual(feed.items.map((i) => i.isNew), [false, false], 'nothing is new before the first visit')
    api.markCreatorViewed(creator.id, 'youtube')
    feed = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube')
    assert.deepEqual(feed.items.map((i) => i.isNew), [true, false])
  } finally { cleanup() }
})

test('notifications report new videos and going live, but not what was there at the first check', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const api = load(dir)
    const followed = api.saveCreator({ name: 'Speed', links: { twitch: 'ishowspeed' }, notify: true })
    api.saveCreator({ name: 'Quiet', links: { twitch: 'quiet' }, notify: false })
    let videos = [{ id: '1', title: 'Old VOD' }]
    let stream = null
    const { fetchImpl, calls } = fakeFetch({
      'https://gql.twitch.tv/gql': () => json({ data: { user: { stream, videos: { edges: videos.map((v) => ({ node: { ...v, publishedAt: '2026-10-01T00:00:00Z' } })) } } } })
    })
    assert.deepEqual(await api.checkCreators(fetchImpl), [])
    videos = [{ id: '2', title: 'New VOD' }, ...videos]
    stream = { title: 'Going live', viewersCount: 10 }
    assert.deepEqual(await api.checkCreators(fetchImpl), [
      { creatorId: followed.id, title: 'Speed posted on Twitch', body: 'New VOD' },
      { creatorId: followed.id, title: 'Speed is live on Twitch', body: 'Going live' }
    ])
    assert.deepEqual(await api.checkCreators(fetchImpl), [], 'each upload and stream is announced once')
    assert.ok(calls.every((c) => JSON.parse(c.init.body).variables.login === 'ishowspeed'), 'creators with notifications off are not checked')
  } finally { cleanup() }
})

test('only creator video and channel pages open from a feed', () => {
  const { isCreatorVideoUrl } = load(tempDir().dir)
  for (const url of ['https://www.youtube.com/watch?v=SOW3qCJJSlQ', 'https://www.youtube.com/shorts/SOW3qCJJSlQ', 'https://www.twitch.tv/videos/2890898173', 'https://www.twitch.tv/ishowspeed', 'https://kick.com/speed/videos/9d0925d9-4a6b-4e10-84f5-9ee9e5bdcd21', 'https://kick.com/speed']) {
    assert.equal(isCreatorVideoUrl(url), true, url)
  }
  for (const url of ['http://www.youtube.com/watch?v=SOW3qCJJSlQ', 'https://www.youtube.com/redirect?q=https://evil', 'https://evil.example/watch?v=SOW3qCJJSlQ', 'file:///C:/x', 'https://kick.com/speed/../../x', 'https://www.twitch.tv/videos/1/../../x', 42]) {
    assert.equal(isCreatorVideoUrl(url), false, String(url))
  }
})

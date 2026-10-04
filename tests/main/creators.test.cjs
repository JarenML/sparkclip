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

/** One video in a YouTube channel grid. */
const ytLockup = ([id, title, badge, ...meta]) => ({ richItemRenderer: { content: { lockupViewModel: {
    contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: {
      image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/small.jpg` }, { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }] },
      overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: badge } }] } }]
    } },
    metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [{
      metadataParts: meta.map((label) => ({ text: { content: label }, accessibilityLabel: label }))
    }] } } } }
  } } } })

const ytContinuation = (token) => ({ continuationItemRenderer: token ? { continuationEndpoint: { continuationCommand: { token } } } : {} })

/** A channel tab page as YouTube serves it: ytInitialData with one lockupViewModel per video. */
const ytPage = (channel, tab, videos, token = null) => {
  const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [
    { tabRenderer: { title: 'Home', endpoint: { commandMetadata: { webCommandMetadata: { url: `/${channel}/featured` } } } } },
    { tabRenderer: { title: tab, selected: true, endpoint: { commandMetadata: { webCommandMetadata: { url: `/${channel}/${tab}` } } },
      content: { richGridRenderer: { contents: [...videos.map(ytLockup), ytContinuation(token)] } } } }
  ] } } }
  return `<html><meta property="og:image" content="https://yt3.googleusercontent.com/avatar=s900">"externalId":"UCWsDFcIhY2DBi3GB5uykGXA"<script>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"2.20261002.01.00"});var ytInitialData = ${JSON.stringify(data)};</script></html>`
}

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
      'https://www.youtube.com/@IShowSpeed/streams': () => new Response(ytPage('@IShowSpeed', 'streams', [
        ['l1veNowXXXX', 'LIVE IN PARIS', 'LIVE', '52K watching'],
        ['SOW3qCJJSlQ', 'RONALDO RETIRED??? & more', '3:05:23', '4 million views', 'Streamed 4 hours ago'],
        ['upcomingXXX', 'Next week', 'UPCOMING', 'Scheduled for 10/10/26'],
        ['ZmCbmzwQF98', 'Gets A Job at KFC!', '2:10:00', '21,345 views', 'Streamed 6 days ago']
      ])),
      'https://www.youtube.com/@IShowSpeed/videos': () => new Response(ytPage('@IShowSpeed', 'videos', [['o1_FvfJD8fg', 'I GOT A JOB AT KFC!', '12:31', '1.9 million views', '6 days ago']])),
      'https://gql.twitch.tv/gql': () => json({ data: { user: { profileImageURL: 'https://static-cdn.jtvnw.net/p.png', stream: { title: 'IRL', viewersCount: 52000 },
        videos: { edges: [{ node: { id: '2890898173', title: 'VOD', publishedAt: '2026-10-03T17:11:49Z', lengthSeconds: 11122, viewCount: 3568, previewThumbnailURL: 'https://static-cdn.jtvnw.net/t.jpg' } }] } } } }),
      'https://kick.com/api/v2/channels/speed/videos': () => json([{ session_title: 'Kick VOD', start_time: '2026-09-23 03:31:33', duration: 3600000, views: 10, thumbnail: { src: 'https://images.kick.com/t.webp' }, video: { uuid: '9d0925d9-4a6b-4e10-84f5-9ee9e5bdcd21' } }]),
      'https://kick.com/api/v2/channels/speed': () => (kickFailures-- > 0 ? new Response('busy', { status: 429 }) : json({ livestream: null, user: { profile_pic: 'https://files.kick.com/p.webp' } })),
      'https://i.ytimg.com/': image, 'https://yt3.googleusercontent.com/': image, 'https://static-cdn.jtvnw.net/': image, 'https://images.kick.com/': image, 'https://files.kick.com/': image
    })

    // YouTube lists the Live tab by default: past streams, and the one on now.
    const youtube = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube')
    assert.equal(youtube.error, null)
    assert.equal(youtube.kind, 'lives')
    assert.deepEqual(youtube.items.map((i) => [i.id, i.title, i.url, i.durationSeconds, i.views]), [
      ['SOW3qCJJSlQ', 'RONALDO RETIRED??? & more', 'https://www.youtube.com/watch?v=SOW3qCJJSlQ', 11123, 4000000],
      ['ZmCbmzwQF98', 'Gets A Job at KFC!', 'https://www.youtube.com/watch?v=ZmCbmzwQF98', 7800, 21345]
    ], 'the stream on now and the scheduled one are not in the list')
    const hoursAgo = (Date.now() - Date.parse(youtube.items[0].publishedAt)) / 3_600_000
    assert.ok(hoursAgo > 3.9 && hoursAgo < 4.1)
    assert.deepEqual(youtube.live, { title: 'LIVE IN PARIS', viewers: 52000, url: 'https://www.youtube.com/watch?v=l1veNowXXXX' })
    assert.match(youtube.items[0].thumbnail, /^data:image\/jpeg;base64,/)
    assert.ok(calls.some((c) => c.url === 'https://i.ytimg.com/vi/SOW3qCJJSlQ/hqdefault.jpg'), 'the largest thumbnail is used')
    assert.match(youtube.avatar, /^data:image\/jpeg;base64,/)

    const uploads = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube', false, 'uploads')
    assert.equal(uploads.kind, 'uploads')
    assert.deepEqual(uploads.items.map((i) => [i.id, i.durationSeconds, i.views]), [['o1_FvfJD8fg', 751, 1900000]])
    assert.equal(uploads.live, null)

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

    // A channel that never streamed has no Live tab: YouTube serves its Home page.
    const home = ytPage('@IShowSpeed', 'featured', [['o1_FvfJD8fg', 'I GOT A JOB AT KFC!', '12:31', '1.9 million views', '6 days ago']])
    const none = await api.getCreatorFeed(async () => new Response(home), creator.id, 'youtube', true)
    assert.deepEqual([none.error, none.items.length, none.live], [null, 0, null])
  } finally { cleanup() }
})

test('Load more adds the next older videos, reading further pages as needed', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const api = load(dir)
    const creator = api.saveCreator({ name: 'Speed', links: { youtube: '@IShowSpeed', twitch: 'ishowspeed', kick: 'speed' }, notify: false })
    const video = (n) => [`vid${String(n).padStart(8, '0')}`, `Stream ${n}`, '1:00:00', '10 views', `Streamed ${n} days ago`]
    const range = (from, to) => Array.from({ length: to - from }, (_, i) => video(from + i))
    const { fetchImpl, calls } = fakeFetch({
      // The page holds 20 videos; the API serves two more pages, repeating one video.
      'https://www.youtube.com/@IShowSpeed/streams': () => new Response(ytPage('@IShowSpeed', 'streams', range(1, 21), 'token-1')),
      'https://www.youtube.com/youtubei/v1/browse': (_url, init) => {
        const { continuation, context } = JSON.parse(init.body)
        assert.equal(context.client.clientVersion, '2.20261002.01.00')
        const items = continuation === 'token-1' ? [...range(20, 26), ytContinuation('token-2')] : range(26, 30)
        return json({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items.map((v) => (Array.isArray(v) ? ytLockup(v) : v)) } }] })
      },
      'https://gql.twitch.tv/gql': () => json({ data: { user: { stream: null, videos: { edges: Array.from({ length: 18 }, (_, i) => ({ node: { id: String(1000 + i), title: `VOD ${i}`, publishedAt: '2026-10-01T00:00:00Z' } })) } } } }),
      'https://kick.com/api/v2/channels/speed/videos': () => json([]),
      'https://kick.com/api/v2/channels/speed': () => json({ livestream: null }),
      'https://i.ytimg.com/': image, 'https://yt3.googleusercontent.com/': image
    })
    const ids = (feed) => feed.items.map((i) => Number(i.id.slice(3)))

    let feed = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube')
    assert.deepEqual([feed.items.length, feed.hasMore], [15, true])
    assert.ok(!calls.some((c) => c.url.includes('youtubei')), 'the first page needs only the channel page')
    feed = await api.getMoreCreatorFeed(fetchImpl, creator.id, 'youtube')
    // 5 left from the page, then both API pages (the repeated video once): 1–29.
    assert.deepEqual(ids(feed), Array.from({ length: 29 }, (_, i) => i + 1))
    assert.equal(feed.hasMore, false)
    assert.ok(feed.items.every((i) => i.thumbnail && !i.isNew))
    assert.deepEqual(ids(await api.getCreatorFeed(fetchImpl, creator.id, 'youtube')), ids(feed), 'reopening the tab keeps what was loaded')
    await assert.rejects(api.getMoreCreatorFeed(fetchImpl, creator.id, 'youtube', 'uploads'), /out of date/)

    // Twitch gives every kept VOD in one large page; Kick in one response.
    feed = await api.getCreatorFeed(fetchImpl, creator.id, 'twitch')
    assert.match(JSON.parse(calls.find((c) => c.url === 'https://gql.twitch.tv/gql').init.body).query, /videos\(first: 100,/)
    assert.deepEqual([feed.items.length, feed.hasMore], [15, true])
    feed = await api.getMoreCreatorFeed(fetchImpl, creator.id, 'twitch')
    assert.deepEqual([feed.items.length, feed.hasMore], [18, false])
    assert.equal((await api.getCreatorFeed(fetchImpl, creator.id, 'kick')).hasMore, false)
  } finally { cleanup() }
})

test('streams that appear after the tab was last opened are new', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const api = load(dir)
    const creator = api.saveCreator({ name: 'Speed', links: { youtube: 'youtube.com/channel/UCWsDFcIhY2DBi3GB5uykGXA' }, notify: false })
    const channel = 'channel/UCWsDFcIhY2DBi3GB5uykGXA'
    let streams = [['ZmCbmzwQF98', 'Last week', '1:00:00', '10 views', 'Streamed 1 week ago']]
    const { fetchImpl } = fakeFetch({
      [`https://www.youtube.com/${channel}/streams`]: () => new Response(ytPage(channel, 'streams', streams)),
      [`https://www.youtube.com/${channel}/videos`]: () => new Response(ytPage(channel, 'videos', [['o1_FvfJD8fg', 'Upload', '12:31', '10 views', '6 days ago']])),
      'https://i.ytimg.com/': image, 'https://yt3.googleusercontent.com/': image
    })
    let feed = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube')
    assert.deepEqual(feed.items.map((i) => i.isNew), [false], 'nothing is new before the first visit')
    api.markCreatorViewed(creator.id, 'youtube')
    // A stream that ended hours ago but wasn't listed at the visit is still new: YouTube's dates are only "N hours ago".
    streams = [['SOW3qCJJSlQ', 'Today', '1:00:00', '10 views', 'Streamed 5 hours ago'], ...streams]
    feed = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube', true)
    assert.deepEqual(feed.items.map((i) => i.isNew), [true, false])
    feed = await api.getCreatorFeed(fetchImpl, creator.id, 'youtube', false, 'uploads')
    assert.deepEqual(feed.items.map((i) => i.isNew), [false], 'a list never opened has nothing new')
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
      { creatorId: followed.id, title: 'New Twitch stream from Speed', body: 'New VOD' },
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

'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain, tempDir, fakeElectron } = require('./support/load-main.cjs')

for (const method of ['log', 'warn', 'error']) console[method] = () => {}

const ACCOUNT = 'a'.repeat(24)
const tmp = tempDir()
const fake = fakeElectron(tmp.dir)
const videos = loadMain(`
  export * from './src/main/zernio/account-videos'
  export { ZernioApiError } from './src/main/zernio/client'
`, { electron: fake.electron })
test.after(() => tmp.cleanup())

const external = (id, extra = {}) => ({
  platform: 'tiktok', platformPostId: id, platformPostUrl: `https://www.tiktok.com/@me/video/${id}`,
  content: `Video ${id}`, publishedAt: `2026-10-0${id}T10:00:00Z`, mediaType: 'video', thumbnailUrl: null,
  analytics: { views: 1500, likes: 90, comments: 3 }, ...extra
})

/** A Zernio client that answers from fixed lists and records what it was asked. */
function client({ externalPosts = [], zernioPosts = [], syncedPosts = [], pages = 1, syncError = null } = {}) {
  const calls = { list: [], sync: [] }
  return {
    calls,
    async listAccountPosts(accountId, source, page, limit) {
      calls.list.push({ accountId, source, page, limit })
      return source === 'external' ? { posts: externalPosts, pages } : { posts: zernioPosts, pages: 1 }
    },
    async syncExternalPosts(accountId) {
      calls.sync.push(accountId)
      if (syncError) throw syncError
      return syncedPosts
    }
  }
}

test('merges platform posts with ones posted through Zernio, newest first, safely', async () => {
  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(url)
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  const zernio = client({
    externalPosts: [
      external('1', { thumbnailUrl: 'https://p16-sign-va.tiktokcdn.com/thumb.jpeg' }),
      external('3', { thumbnailUrl: 'https://evil.example.com/thumb.jpeg', platformPostUrl: 'https://evil.example.com/video/3' }),
      external('2', { content: 'Look\u0000 at https://spam.example' })
    ],
    zernioPosts: [
      // The same video as platform post 2: one card, marked as posted through Zernio.
      { _id: 'z1', content: 'From SparkClip', platforms: [{ platform: 'tiktok', accountId: { _id: ACCOUNT }, platformPostId: '2', platformPostUrl: 'https://www.tiktok.com/@me/video/2', publishedAt: '2026-10-02T10:00:00Z' }] },
      { _id: 'z2', content: 'Only in Zernio', mediaItems: [{ type: 'video' }], platforms: [{ platform: 'tiktok', accountId: ACCOUNT, platformPostId: '9', platformPostUrl: 'https://www.tiktok.com/@me/video/9', publishedAt: '2026-10-09T10:00:00Z' }] },
      // Went to another account only.
      { _id: 'z3', content: 'Elsewhere', platforms: [{ platform: 'tiktok', accountId: 'b'.repeat(24), platformPostId: '7' }] }
    ],
    pages: 3
  })

  const page = await videos.listAccountVideos(ACCOUNT, 1, false, null, { client: zernio, fetchImpl })
  assert.deepEqual(page.videos.map((v) => v.id), ['9', '3', '2', '1'])
  assert.equal(page.nextPage, 2)
  const [onlyZernio, untrusted, both, withThumb] = page.videos
  assert.equal(onlyZernio.viaZernio, true)
  assert.equal(onlyZernio.thumbnail, null)
  // A link off the platform's site is dropped, and so is a thumbnail from an unknown host.
  assert.equal(untrusted.url, null)
  assert.equal(untrusted.thumbnail, null)
  assert.deepEqual(fetched.filter((url) => !url.includes('/oembed')), ['https://p16-sign-va.tiktokcdn.com/thumb.jpeg'])
  // Cards without a thumbnail ask TikTok for the cover, and only for links on tiktok.com.
  assert.ok(fetched.filter((url) => url.includes('/oembed')).every((url) => url.startsWith('https://www.tiktok.com/oembed?url=https%3A%2F%2Fwww.tiktok.com')))
  assert.equal(withThumb.thumbnail, 'data:image/jpeg;base64,AQID')
  assert.equal('thumbnailUrl' in withThumb, false)
  // The platform's copy keeps its counts and caption; control characters and links are cleaned.
  assert.equal(both.viaZernio, true)
  assert.equal(both.views, 1500)
  assert.equal(both.caption, 'Look at [link]')
  // One saved cover failed (the unknown host), so Zernio was asked once for fresh links.
  assert.deepEqual(zernio.calls.sync, [ACCOUNT])
})

test('later pages read only the platform list; refresh syncs first and survives a failed sync', async () => {
  const zernio = client({ externalPosts: [external('4')], pages: 2, syncError: new videos.ZernioApiError('Not found', 404) })
  const second = await videos.listAccountVideos(ACCOUNT, 2, true, null, { client: zernio, fetchImpl: async () => { throw new Error('no network') } })
  assert.deepEqual(zernio.calls.list.map((c) => c.source), ['external'])
  assert.deepEqual(zernio.calls.sync, [], 'only the first page refreshes')
  assert.equal(second.nextPage, null)

  const refreshed = await videos.listAccountVideos(ACCOUNT, 1, true, null, { client: zernio, fetchImpl: async () => { throw new Error('no network') } })
  assert.deepEqual(zernio.calls.sync, [ACCOUNT])
  assert.equal(refreshed.videos.length, 1)

  // A rejected key or the rate limit still stops the refresh.
  const limited = client({ syncError: new videos.ZernioApiError('Slow down', 429) })
  await assert.rejects(videos.listAccountVideos(ACCOUNT, 1, true, null, { client: limited }), /Slow down/)
})

test('rejects bad input and only opens links on the platform', async () => {
  await assert.rejects(videos.listAccountVideos('../accounts', 1, false, null, { client: client() }), /Invalid Zernio account/)
  await assert.rejects(videos.openAccountVideo('https://evil.example.com/v/1', 'tiktok'), /doesn’t have a link/)
  await assert.rejects(videos.openAccountVideo('javascript:alert(1)', 'tiktok'))
  await videos.openAccountVideo('https://www.tiktok.com/@me/video/1', 'tiktok')
  assert.deepEqual(fake.calls.openExternal, ['https://www.tiktok.com/@me/video/1'])
})

test('a refresh shows the posts the sync just read, even before the list has them', async () => {
  const zernio = client({ externalPosts: [external('1')], syncedPosts: [external('1'), external('5')] })
  const page = await videos.listAccountVideos(ACCOUNT, 1, true, null, { client: zernio, fetchImpl: async () => { throw new Error('no network') } })
  assert.deepEqual(page.videos.map((v) => v.id), ['5', '1'])
})

test('reads posts whose fields use other names, taking the platform from the account', async () => {
  const zernio = client({ externalPosts: [{ _id: 'x1', permalink: 'https://www.tiktok.com/@me/video/77', caption: 'Hello', createdAt: '2026-10-01T00:00:00Z', metrics: { plays: 40 } }] })
  const page = await videos.listAccountVideos(ACCOUNT, 1, false, 'tiktok', { client: zernio, fetchImpl: async () => { throw new Error('no network') } })
  assert.equal(page.videos.length, 1)
  assert.equal(page.videos[0].url, 'https://www.tiktok.com/@me/video/77')
  assert.equal(page.videos[0].caption, 'Hello')
  assert.equal(page.videos[0].views, 40)
})

test('a post without a thumbnail gets the cover TikTok shows for it', async () => {
  const cover = 'https://p16-common-sign.tiktokcdn-us.com/cover.jpeg'
  let oembedCalls = 0
  const fetchImpl = async (url) => {
    if (url.startsWith('https://www.tiktok.com/oembed')) {
      oembedCalls += 1
      return oembedCalls === 1
        ? new Response('overload-protect triggered', { status: 503 })
        : new Response(JSON.stringify({ thumbnail_url: cover }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    assert.equal(url, cover)
    return new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  const zernio = client({ externalPosts: [external('6', { platformPostUrl: 'https://www.tiktok.com/@me/video/6' })] })
  // TikTok turned the first request away; the next listing asks again and gets the cover.
  assert.equal((await videos.listAccountVideos(ACCOUNT, 1, false, null, { client: zernio, fetchImpl })).videos[0].thumbnail, null)
  assert.equal((await videos.listAccountVideos(ACCOUNT, 1, false, null, { client: zernio, fetchImpl })).videos[0].thumbnail, 'data:image/jpeg;base64,CQ==')
})

test('an account picture comes only from its saved link on a platform image host', async () => {
  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(url)
    return new Response(new Uint8Array([7]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  const saved = {
    [ACCOUNT]: { id: ACCOUNT, platform: 'tiktok', pictureUrl: 'https://p16-sign-va.tiktokcdn.com/avatar.jpeg' },
    ['b'.repeat(24)]: { id: 'b'.repeat(24), platform: 'tiktok', pictureUrl: 'https://evil.example.com/avatar.jpeg' }
  }
  const findAccount = (id) => saved[id]
  assert.equal(await videos.accountPicture(ACCOUNT, { fetchImpl, findAccount }), 'data:image/jpeg;base64,Bw==')
  assert.equal(await videos.accountPicture('b'.repeat(24), { fetchImpl, findAccount }), null)
  assert.equal(await videos.accountPicture('c'.repeat(24), { fetchImpl, findAccount }), null)
  assert.equal(await videos.accountPicture('../x', { fetchImpl, findAccount }), null)
  assert.deepEqual(fetched, ['https://p16-sign-va.tiktokcdn.com/avatar.jpeg'])
  // Zernio usually serves its own copy of the picture.
  saved['d'.repeat(24)] = { id: 'd'.repeat(24), platform: 'tiktok', pictureUrl: 'https://media.zernio.com/avatars/me.jpg' }
  assert.equal(await videos.accountPicture('d'.repeat(24), { fetchImpl, findAccount }), 'data:image/jpeg;base64,Bw==')
})

test('an expired cover link is replaced by the fresh one a single sync returns', async () => {
  // Its own account: the repair sync is shared per account for a minute.
  const FRESH = 'e'.repeat(24)
  const stale = 'https://p16-common-sign.tiktokcdn.com/cover.jpeg?x-expires=1'
  const fresh = 'https://p16-common-sign.tiktokcdn.com/cover.jpeg?x-expires=2'
  const fetchImpl = async (url) => url === fresh
    ? new Response(new Uint8Array([5]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    : new Response('Forbidden', { status: 403 })
  const post = (id, link) => external(id, { mediaItems: [{ type: 'video', url: link }] })
  const zernio = client({ externalPosts: [post('11', stale), post('12', stale + '2'), external('13')], syncedPosts: [post('11', fresh), post('12', fresh)] })
  const page = await videos.listAccountVideos(FRESH, 1, false, null, { client: zernio, fetchImpl })
  assert.deepEqual(page.videos.map((v) => Boolean(v.thumbnail)), [true, true, false])
  assert.deepEqual(zernio.calls.sync, [FRESH], 'one sync for every failed cover')
  // Opening the account again right away reuses that sync instead of one Zernio would skip.
  const again = await videos.listAccountVideos(FRESH, 1, false, null, { client: zernio, fetchImpl })
  assert.deepEqual(again.videos.map((v) => Boolean(v.thumbnail)), [true, true, false])
  assert.deepEqual(zernio.calls.sync, [FRESH])

  // Nothing to refresh when covers load, or when a post has no saved link at all.
  const quiet = client({ externalPosts: [external('14')] })
  await videos.listAccountVideos(FRESH, 1, false, null, { client: quiet, fetchImpl })
  assert.deepEqual(quiet.calls.sync, [])
})

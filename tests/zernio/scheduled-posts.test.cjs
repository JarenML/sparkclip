'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  stdin: { contents: "export { scheduledPostsFor, tiktokAccountDefaults } from './src/shared/zernio-posts'", resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent'
}).outputFiles[0].text
const module_ = { exports: {} }
vm.runInNewContext(bundle, { module: module_, exports: module_.exports, require })
const { scheduledPostsFor, tiktokAccountDefaults } = module_.exports

const A = 'a'.repeat(24)
const B = 'b'.repeat(24)
const post = (id, status, accounts, scheduledFor = null) => ({
  id, clipPath: `C:/clips/${id}.mp4`, clipTitle: id, status, scheduledFor, timezone: 'UTC', error: null,
  createdAt: '2026-10-01T00:00:00.000Z', uploadedAt: '2026-10-01T00:00:00.000Z', refreshedAt: null,
  targets: accounts.map((accountId) => ({ platform: 'tiktok', accountId, handle: null, status: 'pending', error: null, url: null, inbox: false }))
})

test('an account lists the posts still going out to it, soonest first', () => {
  const posts = [
    post('later', 'scheduled', [A], '2026-10-12T10:00:00.000Z'),
    post('both', 'scheduled', [B, A], '2026-10-10T10:00:00.000Z'),
    post('now', 'publishing', [A]),
    post('done', 'published', [A]),
    post('dropped', 'cancelled', [A], '2026-10-11T10:00:00.000Z'),
    post('other', 'scheduled', [B], '2026-10-09T10:00:00.000Z')
  ]
  assert.deepEqual(scheduledPostsFor(posts, A).map((p) => p.id), ['now', 'both', 'later'])
  assert.deepEqual(scheduledPostsFor(posts, B).map((p) => p.id), ['other', 'both'])
  assert.deepEqual(scheduledPostsFor(posts, 'c'.repeat(24)), [])
})

test('a TikTok account starts on Everyone with every interaction its creator allows', () => {
  const everyone = [{ value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' }, { value: 'SELF_ONLY', label: 'Only me' }]
  assert.deepEqual({ ...tiktokAccountDefaults({ privacyLevels: everyone, interactions: { comment: true, duet: true, stitch: false } }) },
    { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: true, allowStitch: false })
  // Without Everyone on offer, the privacy stays for the user to choose.
  assert.equal(tiktokAccountDefaults({ privacyLevels: [{ value: 'SELF_ONLY', label: 'Only me' }], interactions: { comment: false, duet: true, stitch: true } }).privacyLevel, '')
})

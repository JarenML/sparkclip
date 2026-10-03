'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { loadMain, tempDir } = require('../zernio/support/load-main.cjs')

const share = loadMain("export * from './src/main/lan-share'", {})
const TOKEN = 'a'.repeat(32)

function run(dir, clips) {
  return { source_video_title: 'Stream <b>&</b> friends', clips: clips.map(([name, score, summary], i) => ({
    clip_index: i, s3_url: pathToFileURL(path.join(dir, name)).href, duration_ms: 61000, virality_score: score, summary
  })) }
}

async function serve(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}

test('only private IPv4 network addresses are offered to phones, home Wi-Fi first', () => {
  const addresses = share.lanAddresses({
    // Windows lists Docker and WSL adapters before the Wi-Fi one.
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.22.144.1', internal: false }],
    docker: [{ family: 'IPv4', address: '172.21.0.1', internal: false }],
    vpn: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
    wifi: [{ family: 'IPv4', address: '192.168.1.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    loop: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    public: [{ family: 'IPv4', address: '8.8.8.8', internal: false }, { family: 'IPv4', address: '172.32.0.1', internal: false }]
  })
  assert.deepEqual(addresses, ['192.168.1.20', '10.8.0.2', '172.22.144.1', '172.21.0.1'])
})

test('a share serves its own clips, best first, behind the token and nowhere else', async () => {
  const { dir, cleanup } = tempDir()
  const runDir = path.join(dir, 'run')
  fs.mkdirSync(runDir)
  fs.writeFileSync(path.join(runDir, 'clip_00.mp4'), Buffer.from('0123456789'))
  fs.writeFileSync(path.join(runDir, 'clip_01.mp4'), Buffer.from('abcdefghijklmnopqrstuvwxyz'))
  fs.writeFileSync(path.join(runDir, 'notes.txt'), 'not a clip')
  fs.writeFileSync(path.join(dir, 'outside.mp4'), 'outside the run')
  const clips = share.sharedClips(run(runDir, [
    ['clip_00.mp4', 0.6, 'Second'], ['clip_01.mp4', 0.9, 'Así fue <script>'], ['notes.txt', 1, 'x'], ['../outside.mp4', 1, 'y'], ['missing.mp4', 1, 'z']
  ]), runDir)
  assert.deepEqual(clips.map((clip) => clip.title), ['Así fue <script>', 'Second'])

  const { base, close } = await serve(share.shareHandler(TOKEN, 'Stream <b>&</b> friends', clips))
  try {
    const page = await fetch(`${base}/${TOKEN}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'; media-src 'self'/)
    const html = await page.text()
    assert.match(html, /Stream &lt;b&gt;&amp;&lt;\/b&gt; friends/)
    assert.match(html, /Así fue &lt;script&gt;/)
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /src="clips\/0\.mp4"[\s\S]*src="clips\/1\.mp4"/)

    const whole = await fetch(`${base}/${TOKEN}/clips/0.mp4`)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('content-type'), 'video/mp4')
    assert.equal(whole.headers.get('accept-ranges'), 'bytes')
    assert.equal(await whole.text(), 'abcdefghijklmnopqrstuvwxyz')

    const part = await fetch(`${base}/${TOKEN}/clips/0.mp4`, { headers: { Range: 'bytes=2-5' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/26')
    assert.equal(await part.text(), 'cdef')
    const tail = await fetch(`${base}/${TOKEN}/clips/1.mp4`, { headers: { Range: 'bytes=-3' } })
    assert.equal(await tail.text(), '789')
    for (const range of ['bytes=30-', 'bytes=5-2', 'items=0-1', 'bytes=-']) {
      const bad = await fetch(`${base}/${TOKEN}/clips/1.mp4`, { headers: { Range: range } })
      assert.equal(bad.status, 416, range)
    }

    const download = await fetch(`${base}/${TOKEN}/clips/0.mp4?download=1`)
    assert.match(download.headers.get('content-disposition'), /^attachment; filename="As fue script.mp4"; filename\*=UTF-8''As%C3%AD%20fue%20%3Cscript%3E\.mp4$/)

    for (const url of [
      `${base}/`, `${base}/${'b'.repeat(32)}/`, `${base}/${TOKEN.slice(1)}/`, `${base}/${TOKEN}/clips/2.mp4`,
      `${base}/${TOKEN}/clips/../../outside.mp4`, `${base}/${TOKEN}/clip_00.mp4`, `${base}/${TOKEN}/notes.txt`
    ]) {
      assert.equal((await fetch(url)).status, 404, url)
    }
    assert.equal((await fetch(`${base}/${TOKEN}/`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/${TOKEN}/clips/0.mp4`, { method: 'HEAD' })).headers.get('content-length'), '26')
  } finally { await close(); cleanup() }
})

test('starting a share listens on the network and stopping closes it', async (t) => {
  if (share.lanAddresses().length === 0) return t.skip('This computer has no private network address')
  const { dir, cleanup } = tempDir()
  try {
    fs.writeFileSync(path.join(dir, 'clip_00.mp4'), 'clip')
    const started = await share.startShare(dir, run(dir, [['clip_00.mp4', 0.8, 'Clip']]))
    assert.equal(share.currentShare(), started)
    assert.match(started.urls[0], /^http:\/\/(10|172|192)\.[\d.]+:\d+\/[0-9a-f]{32}\/$/)
    const port = new URL(started.urls[0]).port
    const token = new URL(started.urls[0]).pathname
    assert.equal((await fetch(`http://127.0.0.1:${port}${token}clips/0.mp4`)).status, 200)
    share.stopShare()
    assert.equal(share.currentShare(), null)
    await assert.rejects(fetch(`http://127.0.0.1:${port}${token}`))
    await assert.rejects(share.startShare(dir, run(dir, [['missing.mp4', 1, 'x']])), /no clips to share/)
  } finally { share.stopShare(); cleanup() }
})

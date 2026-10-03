'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const { loadMain, tempDir, fakeElectron, ROOT } = require('../zernio/support/load-main.cjs')
const { directoryLinkType } = require('../support/symlinks.cjs')
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin/ffmpeg')) ? path.join(ROOT, 'engine-bin/ffmpeg') : 'ffmpeg'

const JOB = '0f4c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f'
const OTHER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function load(dir) {
  return loadMain("export { deleteRun, generateThumbnail } from './src/main/file-manager'", { electron: fakeElectron(dir).electron })
}

/** A finished run with real clips (so thumbnails can be made), like the engine writes. */
function makeRun(base, jobId, clipCount = 2) {
  const runDir = path.join(base, jobId)
  fs.mkdirSync(runDir, { recursive: true })
  const clips = []
  for (let i = 0; i < clipCount; i++) {
    const file = path.join(runDir, `clip_0${i}.mp4`)
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:d=0.4', '-c:v', 'mpeg4', file])
    clips.push({ clip_index: i, s3_url: pathToFileURL(file).href, duration_ms: 400, start_time_ms: i * 1000, end_time_ms: i * 1000 + 400, virality_score: 0.8 })
  }
  fs.writeFileSync(path.join(runDir, 'job_output.json'), JSON.stringify({ job_id: jobId, source_video_title: 'Stream', clips }))
  fs.writeFileSync(path.join(runDir, 'transcript.json'), '{"segments":[]}')
  return { runDir, clips: clips.map((clip) => new URL(clip.s3_url)) }
}

function bytesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name)
    return sum + (entry.isDirectory() ? bytesIn(full) : fs.statSync(full).size)
  }, 0)
}

test('deleting a run removes its folder, clip thumbnails, work files and engine log, and nothing else', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const api = load(dir)
    const base = path.join(dir, 'out')
    const { runDir } = makeRun(base, JOB)
    const other = makeRun(base, OTHER, 1)
    // Thumbnails the clip cards, the Library card and the post dialog would have made.
    const thumbs = []
    for (const file of ['clip_00.mp4', 'clip_01.mp4']) {
      const clip = path.join(runDir, file)
      thumbs.push(await api.generateThumbnail(clip, (400 / 1000) * 0.5), await api.generateThumbnail(clip, 400 / 2000), await api.generateThumbnail(clip))
    }
    const otherThumb = await api.generateThumbnail(path.join(other.runDir, 'clip_00.mp4'), 0.2)
    assert.ok(thumbs.every(Boolean) && otherThumb)
    const work = path.join(dir, 'userData', 'work', JOB)
    fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(path.join(work, 'source.mp4'), 'leftover')
    const log = path.join(dir, 'logs', 'engine', `${JOB}.log`)
    fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, 'engine output')
    const bank = path.join(dir, 'userData', 'automation-bank', 'default', 'auto1', 'clip.mp4')
    fs.mkdirSync(path.dirname(bank), { recursive: true }); fs.copyFileSync(path.join(runDir, 'clip_00.mp4'), bank)
    const expected = bytesIn(runDir)

    assert.equal(await api.deleteRun(base, JOB), expected)

    for (const gone of [runDir, work, log, ...thumbs]) assert.equal(fs.existsSync(gone), false, gone)
    // Other runs, their thumbnails and automation copies stay.
    for (const kept of [other.runDir, otherThumb, bank]) assert.ok(fs.existsSync(kept), kept)
  } finally { cleanup() }
})

test('only run folders inside the output folder can be deleted', async (t) => {
  const { dir, cleanup } = tempDir()
  try {
    const api = load(dir)
    const base = path.join(dir, 'out')
    fs.mkdirSync(base, { recursive: true })
    for (const id of ['../out', 'not-a-run', `${JOB}/..`, '']) await assert.rejects(api.deleteRun(base, id), /Invalid run identifier/)
    await assert.rejects(api.deleteRun(base, JOB))
    if (!directoryLinkType) return t.skip('This account cannot create directory links')
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.mp4'), 'keep')
    fs.symlinkSync(outside, path.join(base, JOB), directoryLinkType)
    await assert.rejects(api.deleteRun(base, JOB), /Invalid run folder/)
    assert.ok(fs.existsSync(path.join(outside, 'keep.mp4')))
  } finally { cleanup() }
})

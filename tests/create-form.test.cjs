const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { buildSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const bundled = buildSync({
  stdin: {
    contents: `export { FormatStep, ClipsStep, VideoStep, ReviewStep, JobForm, buildJobRequest, parseTrimRange } from './src/renderer/components/JobForm';
      export { SetupCard } from './src/renderer/components/SetupCard';
      export { useSettingsStore } from './src/renderer/store/use-settings-store';
      export { useDraftStore } from './src/renderer/store/use-draft-store';
      export { SourcePicker, isValidSourceLink } from './src/renderer/components/SourcePicker';
      export { TrimTimeline } from './src/renderer/components/TrimTimeline';
      export { ClipList, framingProblem, sourceAnalysisNotice } from './src/renderer/components/ClipList';
      export { formatBytes } from './src/renderer/lib/utils';
      export { jobInfoSections, rangeLabel } from './src/renderer/components/JobInfoDialog';
      export { qrDataUrl } from './src/renderer/components/ShareDialog';
      export { parseJobOutput, starredClips } from './src/shared/job-output';
      export { ScoreBreakdown } from './src/renderer/components/ClipCard';
      export { twitchVodId, kickVod, normalizeVideoSource } from './src/shared/video-source';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  define: { __APP_VERSION__: JSON.stringify(require('../package.json').version) },
  jsx: 'automatic',
  write: false
}).outputFiles[0].text

const form = { exports: {} }
new Function('module', 'exports', 'require', bundled)(form, form.exports, require)
const { FormatStep, JobForm, isValidSourceLink, parseTrimRange, framingProblem, sourceAnalysisNotice, parseJobOutput } = form.exports

test('setup needs only OpenRouter for clipping', () => {
  const { SetupCard, useSettingsStore } = form.exports
  useSettingsStore.setState({ openrouterConfigured: false })
  const setup = renderToStaticMarkup(React.createElement(SetupCard, { onOpenSettings() {} }))
  assert.match(setup, /OpenRouter/)
  assert.doesNotMatch(setup, /ElevenLabs/)
  useSettingsStore.setState({ openrouterConfigured: false, toolStatus: null })
})

test('source picker accepts full HTTP(S) links and rejects malformed or credentialed links', () => {
  assert.equal(isValidSourceLink(' https://www.youtube.com/watch?v=abc '), true)
  assert.equal(isValidSourceLink('http://example.com/video.mp4'), true)
  assert.equal(isValidSourceLink('https://'), false)
  assert.equal(isValidSourceLink('https://user:pass@example.com/video'), false)
  assert.equal(isValidSourceLink('file:///tmp/video.mp4'), false)
})

test('trim validation matches main process bounds, including an end at zero', () => {
  assert.equal(parseTrimRange(true, '', '0').error, 'End must be after the start.')
  assert.equal(parseTrimRange(true, '1:30', '90').error, 'End must be after the start.')
  assert.deepEqual(parseTrimRange(true, '', '1:30'), { start: null, end: 90, error: null })
  assert.deepEqual(parseTrimRange(false, 'oops', '0'), { start: null, end: null, error: null })
})

test('the wizard opens on the video step with the steps listed in order', () => {
  const html = renderToStaticMarkup(React.createElement(JobForm, { onSubmit() {} }))
  const labels = [...html.matchAll(/aria-label="Create steps">(.*?)<\/nav>/gs)][0]?.[1] ?? ''
  const order = ['Video', 'Format', 'Clips', 'Captions', 'Review'].map((label) => labels.indexOf(label))
  assert.ok(order.every((index, i) => index > -1 && (i === 0 || index > order[i - 1])))
  assert.match(html, /aria-current="step"[^>]*>.*?Video/s)
  assert.match(html, /Choose a video/)
})

test('clipping mode is selectable and economy disables paid vision in the submitted request', () => {
  const { ClipsStep, buildJobRequest } = form.exports
  const draft = {
    source: 'https://example.com/video', clippingMode: 'economy', aspectRatio: '9:16', layoutStyle: 'auto',
    layoutVision: true, pacing: 'tight', durations: ['short'], autoClipCount: true, maxClips: 5,
    includeCaptions: true, captionPreset: 'pop'
  }
  const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft, update() {} }))
  assert.match(html, /aria-label="Clipping mode"/)
  assert.match(html, /Economy/)
  const request = buildJobRequest(draft, { start: null, end: null })
  assert.equal(request.clippingMode, 'economy')
  assert.equal(request.layoutVision, false)
  assert.equal(buildJobRequest({ ...draft, clippingMode: 'quality' }, { start: null, end: null }).layoutVision, true)
  assert.equal(buildJobRequest({ ...draft, titleLanguage: 'es' }, { start: null, end: null }).titleLanguage, 'es')
  // Saving disk space only applies to Twitch and Kick VODs, and is left out when off.
  const kick = 'https://kick.com/elzeein/videos/191061c4-3c2e-46e8-83ef-eca789c89b3c'
  assert.equal(buildJobRequest({ ...draft, source: kick, saveSpace: true }, { start: null, end: null }).saveSpace, true)
  assert.equal('saveSpace' in buildJobRequest({ ...draft, source: kick, saveSpace: false }, { start: null, end: null }), false)
  assert.equal(buildJobRequest({ ...draft, source: 'https://youtu.be/SOW3qCJJSlQ', saveSpace: true }, { start: null, end: null }).saveSpace, true)
  // The chosen creator goes with the run, and is left out when none is.
  assert.equal(buildJobRequest({ ...draft, creatorId: '9d0925d9-4a6b-4e10-84f5-9ee9e5bdcd21' }, { start: null, end: null }).creatorId, '9d0925d9-4a6b-4e10-84f5-9ee9e5bdcd21')
  assert.equal('creatorId' in buildJobRequest({ ...draft, creatorId: '' }, { start: null, end: null }), false)
  assert.equal('saveSpace' in buildJobRequest({ ...draft, saveSpace: true }, { start: null, end: null }), false)
})

test('format and framing radio groups each expose one keyboard tab stop', () => {
  const draft = { aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight' }
  const html = renderToStaticMarkup(React.createElement(FormatStep, { draft, update() {} }))
  for (const label of ['Format', 'Framing', 'Video speed']) {
    const group = html.match(new RegExp(`role="radiogroup" aria-label="${label}"[^>]*>(.*?)<\\/div>`, 's'))?.[1]
    assert.ok(group)
    assert.equal((group.match(/tabindex="0"/g) ?? []).length, 1)
  }
})

test('speed survives navigation and another job, and appears in the submitted request', () => {
  const { useDraftStore, buildJobRequest, ClipsStep } = form.exports
  const original = useDraftStore.getState()
  try {
    assert.equal(original.videoSpeed, 1)
    original.update({ source: 'https://example.com/video', videoSpeed: 1.5 })
    original.setStep('review')
    assert.equal(useDraftStore.getState().step, 'review')
    const lengths = renderToStaticMarkup(React.createElement(ClipsStep, { draft: useDraftStore.getState(), update() {} }))
    assert.match(lengths, /60 seconds becomes about 40 seconds/)
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: 10, end: 70 }).videoSpeed, 1.5)
    original.startAnother()
    assert.equal(useDraftStore.getState().videoSpeed, 1.5)
    assert.equal(useDraftStore.getState().step, 'video')
  } finally { useDraftStore.setState(original) }
})

test('saved run speed is retained while invalid speed metadata is discarded', () => {
  assert.equal(parseJobOutput({ clips: [], metrics: { requested_settings: { video_speed: 1.5 } } }).metrics.requested_settings.video_speed, 1.5)
  for (const video_speed of ['2', null, Infinity, 0, 3]) {
    assert.equal(parseJobOutput({ clips: [], metrics: { requested_settings: { video_speed } } }).metrics.requested_settings.video_speed, undefined)
  }
})

test('advanced selections travel with the job while presets ignore retained custom choices', () => {
  const { ClipsStep, buildJobRequest } = form.exports
  const draft = {
    source: 'https://example.com/video', clippingMode: 'advanced',
    plannerModel: 'provider/planning', transcriptionModel: 'provider/speech',
    aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight',
    durations: ['short'], autoClipCount: true, maxClips: 5, includeCaptions: true, captionPreset: 'pop'
  }
  const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft, update() {} }))
  assert.match(html, /Clip planning model/)
  assert.match(html, /Transcription model/)
  assert.equal((html.match(/role="combobox"/g) ?? []).length, 2)
  const request = buildJobRequest(draft, { start: null, end: null })
  assert.equal(request.plannerModel, 'provider/planning')
  assert.equal(request.transcriptionModel, 'provider/speech')
  assert.equal(request.layoutVision, true)
  for (const clippingMode of ['quality', 'economy']) {
    const preset = buildJobRequest({ ...draft, clippingMode }, { start: null, end: null })
    assert.equal(preset.plannerModel, undefined)
    assert.equal(preset.transcriptionModel, undefined)
  }
})

test('clip list explains when smart framing intentionally keeps the whole frame', () => {
  const clip = (index) => ({
    clip_index: index, s3_url: `/tmp/clip-${index}.mp4`, duration_ms: 5000,
    start_time_ms: index * 5000, end_time_ms: (index + 1) * 5000, virality_score: 0.5
  })
  const output = parseJobOutput({
    clips: [clip(0), clip(1)],
    metrics: { clip_layouts: [
      { clip_index: 0, framing_status: 'whole_frame_auto' },
      { clip_index: 0, framing_status: 'whole_frame_auto' },
      { clip_index: 9, framing_status: 'whole_frame_auto' }
    ] }
  })
  assert.ok(output)
  assert.match(framingProblem(output, true), /whole frame for clip 1/)
  assert.equal(framingProblem(output, false), null)
  const classic = parseJobOutput({ clips: [clip(0)], metrics: {
    smart_framing_available: false, requested_settings: { aspect_ratio: '9:16', layout_style: 'fit' }
  } })
  assert.ok(classic)
  assert.equal(framingProblem(classic, true), null)
})

test('visual-only runs disclose unavailable captions and preserve analysis status', () => {
  const output = parseJobOutput({ clips: [], metrics: {
    transcription_status: 'no_speech', planning_source: 'visual', visual_frame_count: 12,
    captions_status: 'unavailable_without_transcript'
  } })
  assert.ok(output)
  assert.equal(output.metrics.visual_frame_count, 12)
  assert.equal(output.metrics.captions_status, 'unavailable_without_transcript')
  assert.match(sourceAnalysisNotice(output), /No speech was detected/)
})

test('Twitch VOD links canonicalize while other Twitch pages are rejected', () => {
  const { normalizeVideoSource, twitchVodId, SourcePicker } = form.exports
  for (const host of ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv']) {
    const source = `https://${host}/videos/12345/?t=1h&tracking=secret`
    assert.equal(isValidSourceLink(source), true)
    assert.equal(normalizeVideoSource(source), 'https://www.twitch.tv/videos/12345')
    assert.equal(twitchVodId(source), '12345')
  }
  for (const source of ['https://twitch.tv/channel', 'https://clips.twitch.tv/Clip', 'https://player.twitch.tv/?video=123', 'https://twitch.tv/videos/nope', 'https://twitch.tv:8443/videos/123']) assert.equal(isValidSourceLink(source), false)
  assert.equal(twitchVodId('https://twitch.tv.evil.test/videos/123'), null)
  const html = renderToStaticMarkup(React.createElement(SourcePicker, { value: 'https://www.twitch.tv/videos/12345', onChange() {} }))
  assert.match(html, /Twitch VOD/)
  assert.match(html, /Public, completed videos only/)
  assert.doesNotMatch(html, /<img/)
})

test('per-criterion scores are kept and validated', () => {
  const { parseJobOutput, ScoreBreakdown } = form.exports
  const base = { clip_index: 0, s3_url: 'file:///clip.mp4', duration_ms: 30000, start_time_ms: 0, end_time_ms: 30000, virality_score: 0.8 }
  const strong = { hook: 9, standalone: 8, arc: 7, quotability: 7.5, ending: 8 }
  const output = parseJobOutput({ clips: [
    { ...base, scores: strong },
    { ...base, clip_index: 1, scores: { ...strong, ending: 3 } },
    { ...base, clip_index: 2, scores: { ...strong, hook: 11 } },
    { ...base, clip_index: 3, scores: { hook: 9 } },
    { ...base, clip_index: 4 }
  ] })
  assert.deepEqual(output.clips[0].scores, strong)
  assert.deepEqual(output.clips.slice(2).map((clip) => clip.scores), [null, null, null])

  const html = renderToStaticMarkup(React.createElement(ScoreBreakdown, { scores: { ...strong, ending: 3 } }))
  for (const label of ['Hook', 'Standalone', 'Arc', 'Quotable', 'Ending']) assert.match(html, new RegExp(`>${label}<`))
  assert.match(html, /text-warning">3</)
  assert.match(html, />7.5</)
  assert.match(renderToStaticMarkup(React.createElement(ScoreBreakdown, { scores: null })), /not saved for this run/)
})

test('stream tags keep known labels, drop repeats and cap at two; older runs have none', () => {
  const { parseJobOutput } = form.exports
  const base = { s3_url: 'file:///clip.mp4', duration_ms: 30000, start_time_ms: 0, end_time_ms: 30000, virality_score: 0.8 }
  const output = parseJobOutput({ clips: [
    { ...base, clip_index: 0, stream_tags: ['gaming', 'rage'] },
    { ...base, clip_index: 1, stream_tags: ['funny', 'funny', 'podcast', 'hype', 'fail'] },
    { ...base, clip_index: 2, stream_tags: ['toString', 7, null] },
    { ...base, clip_index: 3, stream_tags: 'gaming' },
    { ...base, clip_index: 4 }
  ] })
  assert.deepEqual(output.clips.map((clip) => clip.stream_tags), [['gaming', 'rage'], ['funny', 'hype'], [], [], []])
})

test('the three highest virality scores are starred, ties going to the earlier clip', () => {
  const { starredClips } = form.exports
  const clips = [0.61, 0.83, 0.7, 0.83, 0.9, 0.7].map((virality_score, clip_index) => ({ clip_index, virality_score }))
  assert.deepEqual([...starredClips(clips)].sort(), [1, 3, 4])
  assert.deepEqual([...starredClips(clips.slice(0, 2))].sort(), [0, 1])
  assert.equal(starredClips([]).size, 0)
})

test('Kick VOD links canonicalize while other Kick pages are rejected', () => {
  const { normalizeVideoSource, kickVod, SourcePicker } = form.exports
  const canonical = 'https://kick.com/elzeein/videos/191061c4-3c2e-46e8-83ef-eca789c89b3c'
  for (const source of ['https://kick.com/elzeein/videos/191061c4-3c2e-46e8-83ef-eca789c89b3c', 'https://www.kick.com/ElZeein/videos/191061C4-3C2E-46E8-83EF-ECA789C89B3C/?t=30&utm_source=x', 'https://kick.com:443/elzeein/videos/191061c4-3c2e-46e8-83ef-eca789c89b3c']) {
    assert.equal(isValidSourceLink(source), true)
    assert.equal(normalizeVideoSource(source), canonical)
    assert.deepEqual(kickVod(source), { channel: 'elzeein', id: '191061c4-3c2e-46e8-83ef-eca789c89b3c' })
  }
  for (const source of ['https://kick.com/elzeein', 'https://kick.com/elzeein/clips/clip_01ABC', 'https://kick.com/video/191061c4-3c2e-46e8-83ef-eca789c89b3c', 'https://kick.com/elzeein/videos/nope', 'https://player.kick.com/elzeein/videos/191061c4-3c2e-46e8-83ef-eca789c89b3c', 'https://kick.com:8443/elzeein/videos/191061c4-3c2e-46e8-83ef-eca789c89b3c']) assert.equal(isValidSourceLink(source), false)
  assert.equal(kickVod('https://kick.com.evil.test/elzeein/videos/191061c4-3c2e-46e8-83ef-eca789c89b3c'), null)
  const html = renderToStaticMarkup(React.createElement(SourcePicker, { value: canonical, onChange() {} }))
  assert.match(html, /Kick VOD/)
  assert.match(html, /Public, completed videos only/)
  assert.doesNotMatch(html, /<img/)
})

test('the trim timeline shows both handles over the source length and open bounds at the edges', () => {
  const { TrimTimeline } = form.exports
  const render = (props) => renderToStaticMarkup(React.createElement(TrimTimeline, { duration: 3600, onChange() {}, ...props }))
  const open = render({ start: null, end: null })
  assert.match(open, /aria-label="Trim start"[^>]*aria-valuenow="0"/)
  assert.match(open, /aria-label="Trim end"[^>]*aria-valuenow="3600"/)
  assert.match(open, /1:00:00 selected/)
  const range = render({ start: 90, end: 600 })
  assert.match(range, /aria-valuetext="1:30"/)
  assert.match(range, /aria-valuetext="10:00"/)
  assert.match(range, /8:30 selected/)
  // Out-of-range typed values are clamped to the source.
  assert.match(render({ start: 5000, end: 9000 }), /aria-label="Trim start"[^>]*aria-valuenow="3599"/)
})

test('the save-space switch appears for Twitch and Kick VODs and YouTube videos, starts on, and shows in Review', () => {
  const { VideoStep, ReviewStep, useDraftStore } = form.exports
  const draft = {
    source: 'https://example.com/video', trimOpen: false, trimStart: '', trimEnd: '', saveSpace: false,
    clippingMode: 'quality', aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight', videoSpeed: 1,
    durations: [], autoClipCount: true, maxClips: 5, includeCaptions: true, captionPreset: 'pop', titleLanguage: 'auto'
  }
  const video = (source) => renderToStaticMarkup(React.createElement(VideoStep, { draft: { ...draft, source }, update() {}, trimError: null }))
  assert.doesNotMatch(video('https://example.com/video'), /Save disk space/)
  assert.match(video('https://kick.com/elzeein/videos/191061c4-3c2e-46e8-83ef-eca789c89b3c'), /aria-label="Save disk space"/)
  assert.match(video('https://www.twitch.tv/videos/12345'), /aria-label="Save disk space"/)
  assert.match(video('https://www.youtube.com/watch?v=SOW3qCJJSlQ'), /aria-label="Save disk space"/)
  assert.match(video('https://www.youtube.com/live/SOW3qCJJSlQ'), /aria-label="Save disk space"/)
  assert.equal(useDraftStore.getState().saveSpace, true)
  const review = (source, saveSpace) => renderToStaticMarkup(React.createElement(ReviewStep, { draft: { ...draft, source, saveSpace }, trim: { start: null, end: null }, onEdit() {} }))
  assert.match(review('https://www.twitch.tv/videos/12345', true), /480p to plan, each clip in full quality/)
  assert.doesNotMatch(review('https://www.twitch.tv/videos/12345', false), /480p to plan/)
  assert.doesNotMatch(review('https://example.com/video', true), /480p to plan/)
})

test('a run view offers Delete job only when it can delete, and freed space reads like Explorer', () => {
  const { ClipList, parseJobOutput, formatBytes } = form.exports
  const output = parseJobOutput({ source_video_title: 'casino un rato', clips: [] })
  const view = (props) => renderToStaticMarkup(React.createElement(ClipList, { output, outputDir: 'C:/out/run', ...props }))
  assert.match(view({ onDelete() {} }), />Delete job</)
  assert.doesNotMatch(view({}), /Delete job/)
  assert.deepEqual([285212672, 1503238553, 2048, 12].map(formatBytes), ['272 MB', '1.4 GB', '2 KB', '12 bytes'])
})

test('job details show the pasted link, the clipped range and the settings, and say what older runs lack', () => {
  const { parseJobOutput, jobInfoSections, rangeLabel } = form.exports
  const entry = { jobId: 'j', date: '2026-10-03T22:11:00.000Z', videoTitle: 'DIA 17/365', clipCount: 10, status: 'completed', outputDir: 'C:/Users/me/SparkClip/j', totalCostUsd: 0.31, finishedAt: null, durationMs: 1011000, errorMessage: null }
  const output = parseJobOutput({
    source_video_url: 'https://kick.com/pieroarenast/videos/01a0f53a-d648-7ae5-a441-26abca80991a', source_video_title: 'DIA 17/365', source_video_duration_seconds: 7378.8,
    clips: [],
    metrics: {
      analysis_duration_seconds: 3621,
      requested_settings: {
        start_time_seconds: 3600, end_time_seconds: 7221, duration_ranges: ['short', 'medium', 'bogus'], max_clips: null, auto_clip_count: true,
        include_captions: true, caption_preset: 'pop', clipping_mode: 'quality', planner_model: 'anthropic/claude-opus-5.5',
        transcription_model: 'microsoft/mai-transcribe-2', aspect_ratio: '9:16', layout_style: 'auto', layout_vision_enabled: true,
        pacing: 'tight', title_language: 'auto', video_speed: 1, save_space: true, caption_preset_extra: 'ignored'
      },
      api_costs: { total_estimated_cost_usd: 0.31, transcription: { estimated_cost_usd: 0.2 }, planning: { estimated_cost_usd: 0.11 } }
    }
  })
  assert.deepEqual(output.metrics.requested_settings.duration_ranges, ['short', 'medium'])
  assert.equal('caption_preset_extra' in output.metrics.requested_settings, false)
  const rows = Object.fromEntries(jobInfoSections(entry, output).flatMap((section) => section.rows.map((row) => [row.label, row.value])))
  assert.equal(rows.Link, 'https://kick.com/pieroarenast/videos/01a0f53a-d648-7ae5-a441-26abca80991a')
  assert.equal(rows.Range, '1:00:00 → 2:00:21')
  assert.equal(rows.Analyzed, '1:00:21')
  assert.equal(rows.Lengths, 'Short (30–60s), Medium (1–2m)')
  assert.equal(rows['How many'], 'AI decides')
  assert.equal(rows.Disk, 'Save disk space')
  assert.equal(rows.Titles, 'Same as the video')
  assert.match(rows['API cost'], /^\$0\.31 \(transcription \$0\.20, planning \$0\.11\)$/)
  assert.equal(rows.Folder, 'C:/Users/me/SparkClip/j')

  assert.equal(rangeLabel({ start_time_seconds: null, end_time_seconds: null }), 'Whole video')
  assert.equal(rangeLabel({ start_time_seconds: 90, end_time_seconds: null }), '1:30 → End')
  assert.match(rangeLabel({ clipping_mode: 'quality' }), /^Not recorded/)
  const failed = jobInfoSections({ ...entry, status: 'failed', errorMessage: 'Kick VOD unavailable', totalCostUsd: null }, null)
  assert.deepEqual(failed.map((section) => section.title), ['Source', 'Run'])
  assert.ok(failed[1].rows.some((row) => row.label === 'Error' && row.value === 'Kick VOD unavailable'))
})

test('runs with clips can be opened on a phone through a QR code', () => {
  const { ClipList, parseJobOutput, qrDataUrl } = form.exports
  const withClips = parseJobOutput({ source_video_title: 'Stream', clips: [{ clip_index: 0, s3_url: 'file:///C:/out/run/clip_00.mp4', duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 0.8 }] })
  const empty = parseJobOutput({ source_video_title: 'Stream', clips: [] })
  const view = (output, outputDir) => renderToStaticMarkup(React.createElement(ClipList, { output, outputDir }))
  assert.match(view(withClips, 'C:/out/run'), />View on phone</)
  assert.doesNotMatch(view(empty, 'C:/out/run'), /View on phone/)
  const qr = qrDataUrl('http://192.168.1.20:51234/' + 'a'.repeat(32) + '/')
  assert.match(qr, /^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
})

import { useEffect, useId, useRef, useState } from 'react'
import { Copy, FolderOpen, Info, RotateCcw } from 'lucide-react'
import type { HistoryEntry } from '../../preload/index'
import { DURATION_OPTIONS, TITLE_LANGUAGES } from '../../shared/job-contract'
import { parseJobOutput, type JobOutput } from '../../shared/job-output'
import { getApi } from '../lib/ipc'
import { formatDate, formatDuration, formatTimecode, formatUsd } from '../lib/utils'
import { CAPTION_PRESET_NAMES } from './CaptionPresetPicker'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Skeleton } from './ui/Skeleton'

export interface InfoRow {
  label: string
  value: string
  /** Offer a Copy button (links and paths). */
  copy?: boolean
  mono?: boolean
}

export interface InfoSection {
  title: string
  rows: InfoRow[]
}

const STATUS: Record<HistoryEntry['status'], string> = {
  completed: 'Completed', running: 'Running', failed: 'Failed', cancelled: 'Cancelled',
  interrupted: 'Interrupted', incomplete: 'Unfinished'
}
const MODES: Record<string, string> = { quality: 'Quality', economy: 'Economy', advanced: 'Advanced' }
const FRAMING: Record<string, string> = { auto: 'Smart framing', fill: 'Fill the frame', fit: 'Whole frame' }

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function timecode(value: number): string {
  return formatTimecode(value * 1000)
}

/** The range a run clipped, from its recorded settings. */
export function rangeLabel(settings: Record<string, unknown> | null): string {
  if (!settings || !('start_time_seconds' in settings || 'end_time_seconds' in settings)) return 'Not recorded (run made before ranges were saved)'
  const start = seconds(settings.start_time_seconds)
  const end = seconds(settings.end_time_seconds)
  if (start == null && end == null) return 'Whole video'
  return `${start != null ? timecode(start) : 'Start'} → ${end != null ? timecode(end) : 'End'}`
}

/** Everything known about a run, grouped for the info dialog. */
export function jobInfoSections(entry: HistoryEntry, output: JobOutput | null): InfoSection[] {
  const metrics = output?.metrics ?? null
  const settings = metrics && typeof metrics.requested_settings === 'object' && metrics.requested_settings
    ? metrics.requested_settings as Record<string, unknown> : null
  const sections: InfoSection[] = []

  const source: InfoRow[] = []
  if (output?.source_video_url) {
    const link = /^https?:\/\//i.test(output.source_video_url)
    source.push({ label: link ? 'Link' : 'File', value: output.source_video_url, copy: true, mono: true })
  }
  source.push({ label: 'Video', value: output?.source_video_title || entry.videoTitle })
  if (output && output.source_video_duration_seconds > 0) source.push({ label: 'Length', value: timecode(output.source_video_duration_seconds) })
  sections.push({ title: 'Source', rows: source })

  if (output) {
    const range: InfoRow[] = [{ label: 'Range', value: rangeLabel(settings) }]
    const analyzed = seconds(metrics?.analysis_duration_seconds)
    if (analyzed != null) range.push({ label: 'Analyzed', value: timecode(analyzed) })
    sections.push({ title: 'Part of the video', rows: range })

    const clips: InfoRow[] = [{ label: 'Clips', value: `${output.clips.length} made` }]
    const failed = seconds(metrics?.failed_clip_count)
    if (failed) clips[0].value += ` · ${failed} failed to render`
    if (settings) {
      if (Array.isArray(settings.duration_ranges)) {
        const lengths = DURATION_OPTIONS.filter((option) => (settings.duration_ranges as string[]).includes(option.id))
        clips.push({ label: 'Lengths', value: lengths.length ? lengths.map((option) => `${option.label} (${option.range})`).join(', ') : 'Any length' })
      }
      if (typeof settings.auto_clip_count === 'boolean') {
        clips.push({ label: 'How many', value: settings.auto_clip_count ? 'AI decides' : `Up to ${settings.max_clips ?? '?'}` })
      }
    }
    sections.push({ title: 'Clips', rows: clips })

    if (settings) {
      const style: InfoRow[] = []
      if (settings.aspect_ratio) style.push({ label: 'Format', value: settings.aspect_ratio === '16:9' ? 'Horizontal 16:9' : 'Vertical 9:16' })
      if (settings.layout_style) style.push({ label: 'Framing', value: `${FRAMING[settings.layout_style as string] ?? settings.layout_style}${settings.layout_vision_enabled ? ' · AI vision' : ''}` })
      if (settings.pacing) style.push({ label: 'Pacing', value: settings.pacing === 'tight' ? 'Cut dead air' : 'Keep pauses' })
      if (typeof settings.video_speed === 'number') style.push({ label: 'Speed', value: `${settings.video_speed}×` })
      if (typeof settings.include_captions === 'boolean') {
        style.push({ label: 'Captions', value: settings.include_captions ? CAPTION_PRESET_NAMES[settings.caption_preset as string] ?? 'On' : 'Off' })
      }
      if (settings.title_language) style.push({ label: 'Titles', value: TITLE_LANGUAGES.find((language) => language.code === settings.title_language)?.label ?? String(settings.title_language) })
      if (style.length) sections.push({ title: 'Style', rows: style })

      const ai: InfoRow[] = []
      if (settings.clipping_mode) ai.push({ label: 'Mode', value: MODES[settings.clipping_mode as string] ?? String(settings.clipping_mode) })
      if (settings.transcription_model) ai.push({ label: 'Transcription', value: String(settings.transcription_model), mono: true })
      if (settings.planner_model) ai.push({ label: 'Planning', value: String(settings.planner_model), mono: true })
      if (typeof settings.save_space === 'boolean') ai.push({ label: 'Disk', value: settings.save_space ? 'Save disk space' : 'Full download' })
      if (ai.length) sections.push({ title: 'AI and download', rows: ai })
    }
  }

  const run: InfoRow[] = [{ label: 'Status', value: STATUS[entry.status] }]
  if (entry.errorMessage) run.push({ label: 'Error', value: entry.errorMessage })
  if (!entry.date.startsWith('1970-')) run.push({ label: 'Started', value: formatDate(entry.date) })
  if (entry.durationMs != null) run.push({ label: 'Processing', value: formatDuration(entry.durationMs) })
  const costs = metrics?.api_costs && typeof metrics.api_costs === 'object' ? metrics.api_costs as Record<string, unknown> : null
  if (entry.totalCostUsd != null) {
    const parts = (['transcription', 'planning', 'layout_vision'] as const).flatMap((name) => {
      const cost = (costs?.[name] as Record<string, unknown> | undefined)?.estimated_cost_usd
      return typeof cost === 'number' ? [`${name === 'layout_vision' ? 'vision' : name} ${formatUsd(cost)}`] : []
    })
    run.push({ label: 'API cost', value: `${formatUsd(entry.totalCostUsd)}${parts.length ? ` (${parts.join(', ')})` : ''}` })
  }
  run.push({ label: 'Folder', value: entry.outputDir, copy: true, mono: true })
  sections.push({ title: 'Run', rows: run })
  return sections
}

/** A run's source link, range, settings, models and cost; unfinished runs can run again. */
export function JobInfoDialog({ entry, onClose, onRetry }: { entry: HistoryEntry; onClose: () => void; onRetry?: () => Promise<void> }): React.JSX.Element {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [retrying, setRetrying] = useState(false)
  const [output, setOutput] = useState<JobOutput | null | undefined>(entry.status === 'completed' ? undefined : null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (entry.status !== 'completed') return
    let cancelled = false
    getApi().history.getJob(entry.outputDir)
      .then((raw) => { if (!cancelled) setOutput(parseJobOutput(raw)) })
      .catch(() => { if (!cancelled) setOutput(null) })
    return () => { cancelled = true }
  }, [entry])

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const copy = (row: InfoRow): void => {
    void getApi().clipboard.writeText(row.value).then((ok) => setCopied(ok ? row.label : null)).catch(() => setCopied(null))
  }

  return (
    <Dialog aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[560px]">
      <div className="min-h-0 overflow-y-auto px-5 pb-5 pt-5">
        <h2 id={titleId} className="flex items-start gap-2 text-base font-semibold text-ink">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{entry.videoTitle}</span>
        </h2>
        {output === undefined ? (
          <div className="mt-4 space-y-2" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-4 rounded-full" />)}
          </div>
        ) : (
          jobInfoSections(entry, output).map((section) => (
            <section key={section.title} className="mt-4">
              <h3 className="eyebrow mb-1.5">{section.title}</h3>
              <dl className="glass-well divide-y divide-white/[0.05] overflow-hidden rounded-xl">
                {section.rows.map((row) => (
                  <div key={row.label} className="flex items-start gap-3 px-3 py-2">
                    <dt className="w-24 shrink-0 text-xs text-ink-subtle">{row.label}</dt>
                    <dd className={`min-w-0 flex-1 text-sm text-ink ${row.mono ? 'break-all font-mono text-xs' : 'break-words'}`} data-selectable>{row.value}</dd>
                    {row.copy && (
                      <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(row)} aria-label={`Copy ${row.label.toLowerCase()}`}>
                        {copied === row.label ? 'Copied' : 'Copy'}
                      </Button>
                    )}
                  </div>
                ))}
              </dl>
            </section>
          ))
        )}
      </div>
      <DialogFooter>
        <Button icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => { void getApi().shell.openPath(entry.outputDir) }}>Open folder</Button>
        <Button ref={closeRef} variant={onRetry ? 'secondary' : 'primary'} onClick={onClose}>Close</Button>
        {onRetry && (
          <Button variant="primary" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={retrying}
            onClick={() => { setRetrying(true); void onRetry().finally(() => setRetrying(false)) }}>
            Run again
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}

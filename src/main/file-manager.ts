import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { app } from 'electron'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'fs'
import { open, readdir, rm } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import { fileURLToPath } from 'url'
import { resolveBinary } from './tools'
import { parseJobOutput, type JobOutput } from '../shared/job-output'
import { hasRunRequest, readRunRecord } from './run-history'

export interface JobHistoryEntry {
  jobId: string
  date: string
  videoTitle: string
  clipCount: number
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'interrupted' | 'incomplete'
  outputDir: string
  totalCostUsd: number | null
  finishedAt: string | null
  durationMs: number | null
  errorMessage: string | null
  /** The followed creator the run's clips belong to, if one was chosen. */
  creatorId: string | null
  /** An unfinished run whose options were saved, so it can run again. */
  canRetry: boolean
}

const MAX_JOB_OUTPUT_BYTES = 20 * 1024 * 1024

async function readJobOutput(outputPath: string, libraryDir: string): Promise<{ data: JobOutput; modified: Date } | null> {
  const entry = lstatSync(outputPath)
  if (!entry.isFile() || entry.isSymbolicLink()) return null
  const handle = await open(outputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const file = await handle.stat()
    if (!file.isFile() || file.size > MAX_JOB_OUTPUT_BYTES) return null
    // Windows has no O_NOFOLLOW. Check the name again after opening, then
    // compare it with the file descriptor so a swapped link is not accepted.
    const currentEntry = lstatSync(outputPath)
    if (!currentEntry.isFile() || currentEntry.isSymbolicLink() ||
        file.dev !== currentEntry.dev || file.ino !== currentEntry.ino) return null
    const canonical = realpathSync(outputPath)
    const library = realpathSync(libraryDir)
    const rel = relative(library, canonical)
    const current = statSync(canonical)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) ||
        file.dev !== current.dev || file.ino !== current.ino) return null
    const data = parseJobOutput(JSON.parse(await handle.readFile('utf-8')))
    return data ? { data, modified: file.mtime } : null
  } finally {
    await handle.close()
  }
}

export function ensureOutputDir(baseDir: string): void {
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }
}

export async function getJobHistory(baseDir: string, activeJobIds: ReadonlySet<string> = new Set()): Promise<JobHistoryEntry[]> {
  if (!existsSync(baseDir)) return []

  const entries: JobHistoryEntry[] = []

  try {
    const dirs = (await readdir(baseDir, { withFileTypes: true })).filter((d) => d.isDirectory())

    for (const dir of dirs) {
      const outputPath = join(baseDir, dir.name, 'job_output.json')
      const record = readRunRecord(baseDir, dir.name)
      const durationMs = record?.finishedAt
        ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : null
      try {
        const result = await readJobOutput(outputPath, baseDir)
        if (!result) throw new Error('Unsupported result file')
        const { data } = result
        const costs = data.metrics?.api_costs
        const costVal = costs && typeof costs === 'object' ? (costs as Record<string, unknown>).total_estimated_cost_usd : null
        entries.push({
          jobId: dir.name,
          date: record?.startedAt ?? result.modified.toISOString(),
          videoTitle: data.source_video_title,
          clipCount: data.clips.length,
          status: 'completed',
          outputDir: join(baseDir, dir.name),
          totalCostUsd: typeof costVal === 'number' ? costVal : null,
          finishedAt: record?.finishedAt ?? result.modified.toISOString(),
          durationMs: durationMs ?? (typeof data.processing_time_seconds === 'number' ? Math.round(data.processing_time_seconds * 1000) : null),
          errorMessage: null,
          creatorId: record?.creatorId ?? null,
          canRetry: false
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Desktop jobs use UUIDs. Keep interrupted runs visible without treating
          // unrelated folders in the selected output directory as clip jobs.
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dir.name)) {
            const runDir = join(baseDir, dir.name)
            try {
              const stat = lstatSync(runDir)
              if (stat.isDirectory() && !stat.isSymbolicLink()) {
                const status = record?.status === 'running'
                  ? (activeJobIds.has(dir.name) ? 'running' : 'interrupted')
                  : record?.status === 'failed' || record?.status === 'cancelled'
                    ? record.status : 'incomplete'
                entries.push({ jobId: dir.name, date: record?.startedAt ?? stat.mtime.toISOString(),
                  videoTitle: record?.sourceLabel ?? 'Unfinished run', clipCount: 0,
                  status, outputDir: runDir, totalCostUsd: null,
                  finishedAt: record?.finishedAt ?? null, durationMs,
                  errorMessage: record?.errorMessage ?? null, creatorId: record?.creatorId ?? null,
                  canRetry: status !== 'running' && hasRunRequest(baseDir, dir.name) })
              }
            } catch { /* The run directory was removed during the scan. */ }
          }
          continue
        }
        entries.push({ jobId: dir.name, date: record?.startedAt ?? new Date(0).toISOString(), videoTitle: record?.sourceLabel ?? 'Unreadable run', clipCount: 0,
          status: 'failed', outputDir: join(baseDir, dir.name), totalCostUsd: null,
          finishedAt: record?.finishedAt ?? null, durationMs,
          errorMessage: record?.errorMessage ?? 'The saved result could not be read.', creatorId: record?.creatorId ?? null,
          canRetry: hasRunRequest(baseDir, dir.name) })
      }
    }
  } catch {
    throw new Error('Could not read the clip library')
  }

  return entries.sort((a, b) => b.date.localeCompare(a.date))
}

export async function getJobOutput(outputDir: string, libraryDir = outputDir): Promise<JobOutput | null> {
  const outputPath = join(outputDir, 'job_output.json')
  try {
    return (await readJobOutput(outputPath, libraryDir))?.data ?? null
  } catch {
    return null
  }
}

async function getVideoDurationSeconds(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      resolveBinary('ffprobe'),
      ['-v', 'error', '-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      { timeout: 10000, maxBuffer: 1024 * 1024 }
    )
    const raw = stdout.trim()
    const dur = parseFloat(raw)
    return Number.isFinite(dur) ? dur : null
  } catch {
    return null
  }
}

function thumbnailDirectory(): string {
  return join(app.getPath('userData'), 'thumbnails')
}

/** The cached thumbnail for a video file at a seek time; the name changes whenever the file does. */
function thumbnailFile(source: string, stat: { dev: number; ino: number; size: number; mtimeMs: number }, seekSeconds?: number): string {
  const identity = `${source}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${seekSeconds ?? 'middle'}`
  return join(thumbnailDirectory(), `${createHash('sha256').update(identity).digest('hex')}.jpg`)
}

/**
 * Generate a thumbnail for a video clip using ffmpeg.
 * Seeks to the middle of the clip for a representative frame.
 * If seekSeconds is provided, uses that instead.
 */
export async function generateThumbnail(videoPath: string, seekSeconds?: number): Promise<string | null> {
  if (!/\.(mp4|m4v|mkv|webm|mov|avi|flv)$/i.test(videoPath)) return null
  if (seekSeconds !== undefined && (!Number.isFinite(seekSeconds) || seekSeconds < 0 || seekSeconds > 6 * 60 * 60)) return null
  let source: string
  let sourceStat: ReturnType<typeof statSync>
  try {
    source = realpathSync(videoPath)
    sourceStat = statSync(source)
    if (!sourceStat.isFile()) return null
  } catch { return null }

  const thumbnailDir = thumbnailDirectory()
  mkdirSync(thumbnailDir, { recursive: true, mode: 0o700 })
  if (!lstatSync(thumbnailDir).isDirectory() || lstatSync(thumbnailDir).isSymbolicLink()) return null
  const thumbPath = thumbnailFile(source, sourceStat, seekSeconds)
  if (existsSync(thumbPath) && lstatSync(thumbPath).isFile() && !lstatSync(thumbPath).isSymbolicLink()) return thumbPath
  const tempPath = join(thumbnailDir, `${randomUUID()}.jpg`)

  let seekTo = seekSeconds ?? null

  if (seekTo === null) {
    const duration = await getVideoDurationSeconds(source)
    if (duration !== null && duration > 6 * 60 * 60) return null
    if (duration && duration > 0.5) {
      seekTo = Math.min(duration * 0.5, duration - 0.1)
    } else {
      seekTo = 0
    }
  }

  const ffmpeg = resolveBinary('ffmpeg')
  const frameArgs = ['-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv', '-i', source, '-frames:v', '1', '-q:v', '2', '-vf', 'scale=640:-2', tempPath]

  try {
    await execFileAsync(
      ffmpeg,
      seekTo > 0 ? ['-n', '-ss', seekTo.toFixed(2), ...frameArgs] : ['-n', ...frameArgs],
      { timeout: 15000 }
    )
    if (existsSync(tempPath)) {
      renameSync(tempPath, thumbPath)
      return thumbPath
    }
  } catch {
    // Fallback: grab first frame
    try { unlinkSync(tempPath) } catch { /* The first attempt may not have written a frame. */ }
    try {
      await execFileAsync(ffmpeg, ['-n', ...frameArgs], { timeout: 15000 })
      if (existsSync(tempPath)) {
        renameSync(tempPath, thumbPath)
        return thumbPath
      }
    } catch {
      // ignore
    }
  } finally {
    try { unlinkSync(tempPath) } catch { /* No partial thumbnail remains. */ }
  }
  return null
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Bytes in a directory's regular files; links are counted but never followed. */
async function directorySize(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(path)
    else total += lstatSync(path).size
  }
  return total
}

/**
 * Removes everything a finished run left on disk: its folder in the output
 * directory (clips, transcript, plan and results), the cached thumbnails of
 * its clips, and any leftover work files and engine log. Clips copied into an
 * automation live in that automation's own folder and are kept.
 * Returns the bytes freed.
 */
export async function deleteRun(baseDir: string, jobId: string): Promise<number> {
  if (!RUN_ID.test(jobId)) throw new Error('Invalid run identifier')
  const runDir = join(baseDir, jobId)
  const entry = lstatSync(runDir)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid run folder')
  const rel = relative(realpathSync(baseDir), realpathSync(runDir))
  if (rel !== jobId) throw new Error('Run is outside the output folder')

  // Thumbnail names depend on each clip file, so work them out before deleting.
  // Clip cards ask for the middle frame by duration; posts ask without one.
  const thumbnails: string[] = []
  const output = await getJobOutput(runDir, baseDir)
  for (const clip of output?.clips ?? []) {
    try {
      const source = realpathSync(fileURLToPath(clip.s3_url))
      const inRun = relative(realpathSync(runDir), source)
      if (isAbsolute(inRun) || inRun.startsWith('..')) continue
      const stat = statSync(source)
      const seeks = clip.duration_ms > 0 ? [(clip.duration_ms / 1000) * 0.5, clip.duration_ms / 2000, undefined] : [undefined]
      for (const seek of seeks) thumbnails.push(thumbnailFile(source, stat, seek))
    } catch { /* A clip file that's already gone has no thumbnail to find. */ }
  }

  const freed = await directorySize(runDir)
  await rm(runDir, { recursive: true, force: true })
  for (const path of [
    ...thumbnails,
    join(app.getPath('userData'), 'work', jobId),
    join(app.getPath('logs'), 'engine', `${jobId}.log`)
  ]) {
    await rm(path, { recursive: true, force: true }).catch(() => { /* Best effort: the run itself is gone. */ })
  }
  return freed
}

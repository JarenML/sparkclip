import { kickVod, twitchVodId } from '../shared/video-source'
import type { ClipJobRequest } from '../shared/jobs'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, isAbsolute, join, relative, sep } from 'path'
import { randomUUID } from 'crypto'

export type StoredRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunRecord {
  jobId: string
  startedAt: string
  finishedAt: string | null
  sourceLabel: string
  status: StoredRunStatus
  errorMessage: string | null
  failureCode?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  /** The followed creator the run's clips belong to. */
  creatorId?: string
}

const RUN_FILE = 'run-history.json'
const MAX_RECORD_BYTES = 16 * 1024
/** The options a run started with, so it can run again after a restart. */
const REQUEST_FILE = 'run-request.json'
const MAX_REQUEST_BYTES = 32 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function runDirectory(baseDir: string, jobId: string): string {
  if (!UUID.test(jobId)) throw new Error('Invalid run identifier')
  return join(baseDir, jobId)
}

function checkedDirectory(baseDir: string, jobId: string): string {
  const dir = runDirectory(baseDir, jobId)
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid run directory')
  const rel = relative(realpathSync(baseDir), realpathSync(dir))
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Run is outside the output folder')
  return dir
}

function sourceLabel(source: string): string {
  const twitchId = twitchVodId(source)
  if (twitchId) return `Twitch VOD · ${twitchId}`.slice(0, 160)
  const kick = kickVod(source)
  if (kick) return `Kick VOD · ${kick.channel} · ${kick.id.slice(0, 8)}`.slice(0, 160)
  let label: string
  try {
    const url = new URL(source)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Local source')
    const host = url.hostname.toLowerCase()
    const videoId = (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') && url.pathname === '/watch'
      ? url.searchParams.get('v') : null
    label = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? `YouTube · ${videoId}` : host
  } catch {
    label = basename(source)
  }
  return Array.from(label, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('').trim().slice(0, 160) || 'Video source'
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

/** A run file's JSON, or null when it is missing, oversized or linked elsewhere. */
function readRunFile(baseDir: string, jobId: string, name: string, maxBytes: number): unknown {
  let fd: number | null = null
  try {
    const file = join(checkedDirectory(baseDir, jobId), name)
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) return null
    const fileStat = lstatSync(file)
    if (fileStat.isSymbolicLink() || fileStat.dev !== stat.dev || fileStat.ino !== stat.ino) return null
    return JSON.parse(readFileSync(fd, 'utf8'))
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function writeRunFile(baseDir: string, jobId: string, name: string, data: unknown): void {
  const dir = checkedDirectory(baseDir, jobId)
  const temp = join(dir, `${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temp, join(dir, name))
  } finally {
    try { unlinkSync(temp) } catch { /* The rename already moved it. */ }
  }
}

export function readRunRecord(baseDir: string, jobId: string): RunRecord | null {
  try {
    const data = readRunFile(baseDir, jobId, RUN_FILE, MAX_RECORD_BYTES)
    if (!data || typeof data !== 'object') return null
    const record = data as Partial<RunRecord>
    if (record.jobId !== jobId || !validDate(record.startedAt) ||
        (record.finishedAt !== null && !validDate(record.finishedAt)) ||
        typeof record.sourceLabel !== 'string' || record.sourceLabel.length > 160 ||
        !['running', 'completed', 'failed', 'cancelled'].includes(record.status ?? '') ||
        (record.errorMessage !== null && (typeof record.errorMessage !== 'string' || record.errorMessage.length > 300)) ||
        (record.failureCode != null && (typeof record.failureCode !== 'string' || !/^[a-z]+(?:[._][a-z]+)*$/.test(record.failureCode) || record.failureCode.length > 64)) ||
        (record.failureStage != null && !['setup', 'download', 'transcription', 'planning', 'rendering', 'saving', 'uploading'].includes(record.failureStage)) ||
        (record.httpStatus != null && (!Number.isInteger(record.httpStatus) || record.httpStatus < 100 || record.httpStatus > 599)) ||
        (record.creatorId !== undefined && (typeof record.creatorId !== 'string' || !UUID.test(record.creatorId)))) return null
    return record as RunRecord
  } catch {
    return null
  }
}

function writeRunRecord(baseDir: string, record: RunRecord): void {
  writeRunFile(baseDir, record.jobId, RUN_FILE, record)
}

/**
 * Keep the options a run started with in its private run folder. Finished runs
 * already hold the source link in job_output.json; this lets a failed,
 * cancelled or interrupted run start again after the app restarts.
 */
export function saveRunRequest(baseDir: string, jobId: string, request: ClipJobRequest): void {
  const saved: ClipJobRequest & { plannerCapabilities?: unknown } = { ...request }
  // Model capabilities are looked up again when the run starts.
  delete saved.plannerCapabilities
  writeRunFile(baseDir, jobId, REQUEST_FILE, saved)
}

/** The saved options of a run, unvalidated; callers check them as new input. */
export function readRunRequest(baseDir: string, jobId: string): unknown {
  return readRunFile(baseDir, jobId, REQUEST_FILE, MAX_REQUEST_BYTES)
}

export function hasRunRequest(baseDir: string, jobId: string): boolean {
  try {
    const stat = lstatSync(join(runDirectory(baseDir, jobId), REQUEST_FILE))
    return stat.isFile() && stat.size <= MAX_REQUEST_BYTES
  } catch {
    return false
  }
}

export function createRunRecord(baseDir: string, jobId: string, source: string, creatorId?: string): void {
  mkdirSync(runDirectory(baseDir, jobId), { recursive: true, mode: 0o700 })
  writeRunRecord(baseDir, {
    jobId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceLabel: sourceLabel(source),
    status: 'running',
    errorMessage: null,
    ...(creatorId ? { creatorId } : {})
  })
}

/**
 * Assign a run's clips to a followed creator, or to none with null. A finished
 * run from before run records existed gets one dated by its result file.
 */
export function setRunCreator(baseDir: string, jobId: string, creatorId: string | null): void {
  if (creatorId !== null && !UUID.test(creatorId)) throw new Error('Invalid creator')
  let record = readRunRecord(baseDir, jobId)
  if (!record) {
    const result = lstatSync(join(checkedDirectory(baseDir, jobId), 'job_output.json'))
    if (!result.isFile()) throw new Error('This run has no clips')
    const date = result.mtime.toISOString()
    record = { jobId, startedAt: date, finishedAt: date, sourceLabel: 'Video source', status: 'completed', errorMessage: null }
  }
  const next: RunRecord = { ...record }
  if (creatorId) next.creatorId = creatorId
  else delete next.creatorId
  writeRunRecord(baseDir, next)
}

export function finishRunRecord(baseDir: string, jobId: string, status: Exclude<StoredRunStatus, 'running'>, errorMessage: string | null = null,
  details: Pick<RunRecord, 'failureCode' | 'failureStage' | 'httpStatus'> = {}): void {
  const previous = readRunRecord(baseDir, jobId)
  if (!previous || previous.status !== 'running') return
  writeRunRecord(baseDir, { ...previous, status, finishedAt: new Date().toISOString(), errorMessage, ...details })
}

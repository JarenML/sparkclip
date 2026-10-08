import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell } from 'electron'
import { existsSync, realpathSync } from 'fs'
import { loadSettings, publicSettings, replaceApiKey, savePublicSettings, type ApiKeyName, type PublicSettings } from './settings-store'
import { deleteRun, ensureOutputDir, getJobHistory, getJobOutput, generateThumbnail } from './file-manager'
import { currentShare, startShare, stopShare } from './lan-share'
import type { CreatorInput } from '../shared/creators'
import { creatorProfileLink, deleteCreator, getCreatorAvatar, getCreatorFeed, getMoreCreatorFeed, listCreators, markCreatorViewed, saveCreator, setCreatorNotify } from './creators'
import {
  getEnginePath,
  getBridgeRunnerPath,
  resolvePythonPath,
  validatePython,
  preflightCheck,
  type ClipJobConfig
} from './pipeline-runner'
import { createRunRecord, finishRunRecord, readRunRequest, saveRunRequest, setRunCreator } from './run-history'
import { cancelTrackedJob, dismissJob, enqueueJob, initJobManager, listJobs, liveJobIds } from './job-manager'
import { logger, getLogFilePath } from './logger'
import { assertAbsolutePath, assertMediaPath, assertTrustedSender, authorizeMedia, isTrustedExternalUrl, isWebUrl, isWithinDirectory, openAuthorizedMedia } from './security'
import { assertPublicWebUrl } from './network-policy'
import { validateJobConfig } from './validation'
import { getSourcePreview } from './source-preview'
import { getModelCatalog, resolveAdvancedModels } from './openrouter-models'
import { randomUUID } from 'crypto'
import { resolveBinary, supportsCaptionFilter } from './tools'
import { approveAutomationTikTokReview, prepareAutomationTikTokReview, addAutomationContent, addLibraryClipsToAutomation, createAutomation, deleteAutomation, isAutomationMedia, listAutomations, removeAutomationContent, runAutomation, updateAutomation, updateAutomationContent } from './automations'
import {
  cancelZernioConnect,
  connectZernioAccount,
  createZernioProfile,
  disconnectZernioAccount,
  getPendingZernioConnect,
  getZernioOverview,
  readCachedOverview,
  resetZernioState,
  syncZernioAccounts
} from './zernio/service'
import {
  cancelPost,
  cancelUpload,
  dismissPost,
  getTikTokCreatorInfo,
  listPosts,
  openPostLink,
  openTikTokLegal,
  probeClipForPosting,
  publishClip,
  refreshPosts,
  reschedulePost,
  retryPost
} from './zernio/posts'
import { listAccountVideos, openAccountVideo } from './zernio/account-videos'

/** A passing engine check is reused briefly, so queuing several videos stays quick. */
const ENGINE_CHECK_TTL_MS = 5 * 60 * 1000

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  const selectedOutputDirectories = new Set<string>()
  let lastEngineCheck: { key: string; at: number } | null = null
  initJobManager(getMainWindow)
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, getMainWindow())
    return listener(event, ...args)
  })
  handle('settings:load', () => {
    return publicSettings(loadSettings())
  })
  handle('models:list', (_event, refresh: unknown = false) => getModelCatalog(refresh))

  handle('settings:save', (_event, settings: PublicSettings) => {
    const current = loadSettings()
    if (!settings || typeof settings !== 'object') throw new Error('Invalid settings')
    if (typeof settings.outputDirectory !== 'string' || typeof settings.pythonPath !== 'string' || typeof settings.customVocabulary !== 'string') throw new Error('Invalid settings')
    if (settings.outputDirectory !== current.outputDirectory && !selectedOutputDirectories.has(settings.outputDirectory)) throw new Error('Choose the output folder with the folder picker')
    if (app.isPackaged && settings.pythonPath !== current.pythonPath) throw new Error('Runtime paths cannot be changed in packaged builds')
    return savePublicSettings(settings)
  })

  handle('settings:replaceApiKey', (_event, key: ApiKeyName, value: string) => {
    const previousZernioKey = key === 'zernioApiKey' ? loadSettings().zernioApiKey : null
    const saved = replaceApiKey(key, value)
    // A different Zernio key may be a different workspace; drop the old one's accounts.
    if (previousZernioKey !== null && loadSettings().zernioApiKey !== previousZernioKey) resetZernioState(getMainWindow)
    return saved
  })

  // Social accounts via the user's own Zernio key (main process only).
  handle('zernio:overview', () => getZernioOverview())
  handle('zernio:profiles:create', (_event, name: unknown) => createZernioProfile(name))
  handle('zernio:sync', () => syncZernioAccounts())
  handle('zernio:cachedOverview', () => readCachedOverview())
  handle('zernio:pendingConnect', () => getPendingZernioConnect())
  handle('zernio:connect', (_event, platform: unknown, profileId: unknown, options: unknown) => connectZernioAccount(platform, profileId, options, getMainWindow))
  handle('zernio:cancelConnect', () => cancelZernioConnect())
  handle('zernio:disconnect', (_event, accountId: unknown) => disconnectZernioAccount(accountId))
  handle('zernio:videos:list', (_event, accountId: unknown, page: unknown, refresh: unknown, platform: unknown) => listAccountVideos(accountId, page, refresh, platform))
  handle('zernio:videos:open', (_event, url: unknown, platform: unknown) => openAccountVideo(url, platform))

  // Posting clips through Zernio. Uploads and post links stay in the main process.
  handle('zernio:posts:probe', (_event, clipPath: unknown, durationMs: unknown) => probeClipForPosting(clipPath, durationMs))
  handle('zernio:posts:tiktokCreatorInfo', (_event, accountId: unknown) => getTikTokCreatorInfo(accountId))
  handle('zernio:posts:publish', (event, request: unknown) => publishClip(request, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('zernio:postProgress', progress)
  }))
  handle('zernio:posts:cancelUpload', (_event, attemptId: unknown) => cancelUpload(attemptId))
  handle('zernio:posts:list', () => listPosts())
  handle('zernio:posts:refresh', (_event, force: unknown) => refreshPosts(force))
  handle('zernio:posts:cancel', (_event, postId: unknown) => cancelPost(postId))
  handle('zernio:posts:reschedule', (_event, postId: unknown, scheduledFor: unknown, timezone: unknown) => reschedulePost(postId, scheduledFor, timezone))
  handle('zernio:posts:retry', (_event, postId: unknown) => retryPost(postId))
  handle('zernio:posts:dismiss', (_event, postId: unknown) => dismissPost(postId))
  handle('zernio:posts:open', (_event, postId: unknown, targetIndex: unknown) => openPostLink(postId, targetIndex))
  handle('zernio:posts:openTikTokLegal', (_event, key: unknown) => openTikTokLegal(key))

  handle('automations:list', () => listAutomations())
  handle('automations:create', (_event, name: unknown) => createAutomation(name))
  handle('automations:update', (_event, id: unknown, update: unknown) => updateAutomation(id, update))
  handle('automations:delete', (_event, id: unknown) => deleteAutomation(id))
  handle('automations:run', (_event, id: unknown) => runAutomation(id))
  handle('automations:addLibraryClips', (_event, id: unknown, outputDir: unknown, clipIndices: unknown) => addLibraryClipsToAutomation(id, outputDir, clipIndices))
  handle('automations:updateContent', (_event, id: unknown, contentId: unknown, update: unknown) => updateAutomationContent(id, contentId, update))
  handle('automations:prepareTikTokReview', (_event, id: unknown, contentId: unknown) => prepareAutomationTikTokReview(id, contentId))
  handle('automations:approveTikTokReview', (_event, id: unknown, contentId: unknown, update: unknown) => approveAutomationTikTokReview(id, contentId, update))
  handle('automations:removeContent', (_event, id: unknown, contentId: unknown) => removeAutomationContent(id, contentId))
  handle('automations:addContent', async (_event, id: unknown) => {
    const window = getMainWindow()
    if (!window) return listAutomations()
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Add clips to automation',
      filters: [{ name: 'Postable videos', extensions: ['mp4', 'mov', 'm4v', 'webm'] }]
    })
    if (result.canceled) return listAutomations()
    for (const path of result.filePaths) authorizeMedia(path)
    return addAutomationContent(id, result.filePaths)
  })

  handle('settings:selectOutputDir', async () => {
    const window = getMainWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Output Folder'
    })

    if (result.canceled || result.filePaths.length === 0) return null
    selectedOutputDirectories.add(result.filePaths[0])
    return result.filePaths[0]
  })

  // Checks a run's options and queues it: new runs from the renderer and runs
  // started again from their saved options take the same path.
  const startJob = async (config: ClipJobConfig): Promise<{ jobId?: string; queued?: boolean; error?: string }> => {
    const window = getMainWindow()
    if (!window) {
      logger.warn('job.start.noWindow')
      return { error: 'No window' }
    }

    try {
      config = validateJobConfig(config)
      if (config.clippingMode === 'advanced') {
        config.plannerCapabilities = await resolveAdvancedModels(config.plannerModel!, config.transcriptionModel!)
      }
      if (isWebUrl(config.videoUrl)) await assertPublicWebUrl(config.videoUrl)
      else assertMediaPath(config.videoUrl, loadSettings().outputDirectory)
      if (config.bannerChannelUrl) await assertPublicWebUrl(config.bannerChannelUrl)
    } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid job options' } }
    const settings = loadSettings()

    if (!settings.openrouterApiKey) {
      logger.warn('job.start.missingKey', { key: 'OPENROUTER_API_KEY' })
      return { error: 'OpenRouter API key is required for AI clip planning. Go to Settings to add it.' }
    }

    const enginePath = getEnginePath()
    const bridgePath = getBridgeRunnerPath()
    const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)

    const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
    if (!preflight.ok) {
      const message = preflight.hint
        ? `${preflight.error}\n\n${preflight.hint}`
        : preflight.error!
      logger.error('job.start.preflight.failed', {
        error: preflight.error,
        hint: preflight.hint,
        pythonPath,
        bridgePath,
        enginePath
      })
      return { error: message }
    }
    const engineKey = `${pythonPath}\0${enginePath}`
    if (!lastEngineCheck || lastEngineCheck.key !== engineKey || Date.now() - lastEngineCheck.at > ENGINE_CHECK_TTL_MS) {
      const pythonValidation = await validatePython(pythonPath, enginePath)
      if (!pythonValidation.ok) {
        lastEngineCheck = null
        return { error: 'The clipping engine is incomplete or incompatible. Open Settings → System check, then repair the SparkClip installation before starting.' }
      }
      lastEngineCheck = { key: engineKey, at: Date.now() }
    }
    if (config.includeCaptions && !(await supportsCaptionFilter())) {
      return { error: 'FFmpeg cannot render captions because its ass filter is missing. Install an FFmpeg build with libass, or turn captions off.' }
    }

    ensureOutputDir(settings.outputDirectory)

    const jobId = randomUUID()
    logger.info('job.start.request', { jobId, sourceType: isWebUrl(config.videoUrl) ? 'remote' : 'local', aspectRatio: config.aspectRatio })
    try {
      createRunRecord(settings.outputDirectory, jobId, config.videoUrl, config.creatorId)
    } catch {
      try { finishRunRecord(settings.outputDirectory, jobId, 'failed', 'Could not start this run.') } catch { /* Output folder may be unavailable. */ }
      return { error: 'Could not create the clipping run. Check the output folder and retry.' }
    }
    // Without saved options the run still works; it just can't run again later.
    try { saveRunRequest(settings.outputDirectory, jobId, config) } catch { logger.warn('job.request.saveFailed', { jobId }) }
    // Starts now when a slot is free; otherwise waits its turn in the queue.
    const job = enqueueJob(jobId, config, settings.outputDirectory)
    return { jobId, queued: job.status === 'queued' }
  }

  handle('job:start', (_event, config: ClipJobConfig) => startJob(config))

  handle('history:retry', (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') throw new Error('Invalid run identifier')
    if (liveJobIds().has(jobId)) return { error: 'This job is still running.' }
    const request = readRunRequest(loadSettings().outputDirectory, jobId)
    if (!request) return { error: 'This run’s options weren’t saved. Start it again from Create.' }
    logger.info('job.retry', { jobId })
    return startJob(request as ClipJobConfig)
  })

  handle('job:cancel', (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') return false
    logger.info('job.cancel.request', { jobId })
    return cancelTrackedJob(jobId)
  })

  handle('jobs:list', () => listJobs())
  handle('jobs:dismiss', (_event, jobId: unknown) => typeof jobId === 'string' && dismissJob(jobId))

  handle('diagnostics:getLogPath', () => {
    return getLogFilePath()
  })

  handle('diagnostics:openLogFolder', () => {
    const logFile = getLogFilePath()
    if (existsSync(logFile)) {
      shell.showItemInFolder(logFile)
      return true
    }
    return false
  })

  handle('history:list', () => {
    const settings = loadSettings()
    return getJobHistory(settings.outputDirectory, liveJobIds())
  })

  handle('history:delete', async (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') throw new Error('Invalid run identifier')
    if (liveJobIds().has(jobId)) throw new Error('This job is still running. Cancel it before deleting it.')
    const freedBytes = await deleteRun(loadSettings().outputDirectory, jobId)
    dismissJob(jobId)
    logger.info('history.delete', { jobId, freedBytes })
    return { freedBytes }
  })

  handle('history:setCreator', (_event, jobId: unknown, creatorId: unknown) => {
    if (typeof jobId !== 'string') throw new Error('Invalid run identifier')
    if (creatorId !== null && !listCreators().some((creator) => creator.id === creatorId)) throw new Error('This creator is no longer in Creators.')
    setRunCreator(loadSettings().outputDirectory, jobId, creatorId as string | null)
    return true
  })

  handle('share:start', async (_event, outputDir: unknown) => {
    assertAbsolutePath(outputDir)
    const library = loadSettings().outputDirectory
    if (!isWithinDirectory(outputDir, library)) throw new Error('Job is outside the library')
    const output = await getJobOutput(outputDir, library)
    if (!output) throw new Error('This run’s clips are unavailable.')
    const share = await startShare(outputDir, output)
    logger.info('share.start', { addresses: share.urls.length })
    return share
  })
  handle('share:stop', () => { stopShare(); return true })
  handle('share:status', () => currentShare())

  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => net.fetch(url, init)
  handle('creators:list', () => listCreators())
  handle('creators:save', (_event, input: unknown, id: unknown) => saveCreator(input as CreatorInput, typeof id === 'string' ? id : undefined))
  handle('creators:delete', (_event, id: unknown) => deleteCreator(id))
  handle('creators:notify', (_event, id: unknown, on: unknown) => setCreatorNotify(id, on))
  handle('creators:feed', (_event, id: unknown, platform: unknown, refresh: unknown, kind: unknown) => getCreatorFeed(fetchImpl, id, platform, refresh === true, kind))
  handle('creators:more', (_event, id: unknown, platform: unknown, kind: unknown) => getMoreCreatorFeed(fetchImpl, id, platform, kind))
  handle('creators:viewed', (_event, id: unknown, platform: unknown) => { markCreatorViewed(id, platform); return true })
  handle('creators:avatar', (_event, id: unknown) => getCreatorAvatar(fetchImpl, id))
  handle('creators:openProfile', async (_event, id: unknown, platform: unknown) => {
    const link = creatorProfileLink(id, platform)
    if (!link) return false
    await shell.openExternal(link)
    return true
  })
  // Videos listed in a creator's feed open in the browser; only their own
  // https pages on YouTube, Twitch and Kick qualify.
  handle('creators:openVideo', async (_event, url: unknown) => {
    if (!isCreatorVideoUrl(url)) return false
    await shell.openExternal(url)
    return true
  })

  handle('history:getJob', (_event, outputDir: string) => {
    assertAbsolutePath(outputDir)
    if (!isWithinDirectory(outputDir, loadSettings().outputDirectory)) throw new Error('Job is outside the library')
    return getJobOutput(outputDir, loadSettings().outputDirectory)
  })

  handle('thumbnails:generate', async (_event, videoPath: string, seekSeconds?: number) => {
    if (isAutomationMedia(videoPath)) authorizeMedia(videoPath)
    else assertMediaPath(videoPath, loadSettings().outputDirectory)
    if (seekSeconds !== undefined && (!Number.isFinite(seekSeconds) || seekSeconds < 0 || seekSeconds > 6 * 60 * 60)) throw new Error('Invalid thumbnail time')
    const thumbnail = await generateThumbnail(videoPath, seekSeconds)
    if (thumbnail) authorizeMedia(thumbnail)
    return thumbnail
  })

  handle('source:preview', (_event, source: unknown) => {
    if (typeof source !== 'string' || source.length > 2048 || !isWebUrl(source)) return null
    return getSourcePreview((url, init) => net.fetch(url, init), source)
  })

  handle('shell:openPath', async (_event, path: unknown) => {
    if (isWebUrl(path)) {
      if (!isTrustedExternalUrl(path)) throw new Error('This external link is not supported')
      await shell.openExternal(path)
      return true
    }
    assertAbsolutePath(path)
    if (!existsSync(path)) return false
    // Check and open the same canonical name: an alias can hide a .app suffix.
    const canonical = realpathSync(path)
    if (!isWithinDirectory(canonical, loadSettings().outputDirectory)) assertMediaPath(canonical, loadSettings().outputDirectory)
    const { statSync } = await import('fs')
    if (statSync(canonical).isDirectory()) {
      if (canonical.split(/[\\/]+/).some((part) => /\.(app|bundle)$/i.test(part))) throw new Error('Application bundles cannot be opened from the library')
    } else {
      assertMediaPath(canonical, loadSettings().outputDirectory)
    }
    return (await shell.openPath(canonical)) === ''
  })

  // The window denies every web permission, clipboard writes included, so
  // copying goes through here: plain text only, and short.
  handle('clipboard:writeText', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length === 0 || text.length > 8192) return false
    clipboard.writeText(text)
    return true
  })

  handle('shell:showItemInFolder', (_event, path: string) => {
    assertAbsolutePath(path)
    if (!isWithinDirectory(path, loadSettings().outputDirectory)) assertMediaPath(path, loadSettings().outputDirectory)
    if (!existsSync(path)) return false
    shell.showItemInFolder(path)
    return true
  })

  handle('dialog:selectVideo', async () => {
    const window = getMainWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: 'Choose a Video',
      filters: [
        { name: 'Video Files', extensions: ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'flv'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return authorizeMedia(result.filePaths[0])
  })

  handle('clips:bulkExport', async (_event, clips: { path: string; name: string }[]) => {
    const window = getMainWindow()
    if (!Array.isArray(clips) || clips.length > 500) throw new Error('Invalid export selection')
    for (const clip of clips) {
      if (!clip || typeof clip.name !== 'string' || clip.name.length > 500) throw new Error('Invalid export selection')
      assertMediaPath(clip.path, loadSettings().outputDirectory)
    }
    if (!window || clips.length === 0) return { success: false, count: 0, failedCount: clips.length }

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Export Clips To…'
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false, count: 0, failedCount: 0 }

    const destDir = result.filePaths[0]
    const { open, rm } = await import('fs/promises')
    const { pipeline } = await import('stream/promises')
    const { extname, join } = await import('path')
    let count = 0

    for (const clip of clips) {
      try {
        const source = await openAuthorizedMedia(clip.path, loadSettings().outputDirectory)
        try {
          const ext = extname(clip.path) || '.mp4'
          const safeName = Array.from(clip.name).filter((char) => char.charCodeAt(0) >= 32).join('').replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'clip'
          let suffix = 0
          while (true) {
            const dest = join(destDir, `${safeName}${suffix ? ` (${suffix})` : ''}${ext}`)
            let target: Awaited<ReturnType<typeof open>> | undefined
            try {
              target = await open(dest, 'wx', 0o600)
              await pipeline(source.handle.createReadStream({ autoClose: false }), target.createWriteStream({ autoClose: false }))
              await target.close()
              break
            } catch (error) {
              await target?.close()
              if (target) await rm(dest, { force: true })
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || ++suffix > 10000) throw error
            }
          }
          count++
        } finally {
          await source.handle.close()
        }
      } catch { /* Counted below as an unsuccessful copy. */ }
    }

    return { success: count > 0, count, failedCount: clips.length - count, destDir }
  })

  handle('system:isPackaged', () => {
    return app.isPackaged
  })

  handle('system:checkTools', async () => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const { join } = await import('path')
    const settings = loadSettings()
    const enginePath = getEnginePath()
    const bridgePath = getBridgeRunnerPath()
    const resolvedPython = resolvePythonPath(enginePath, settings.pythonPath)

    // ffmpeg/ffprobe only accept `-version`; `--version` exits non-zero and
    // made the check report them missing even when installed.
    const check = async (cmd: string, flag = '--version'): Promise<boolean> => {
      try {
        await execFileAsync(cmd, [flag], { timeout: 5000 })
        return true
      } catch {
        return false
      }
    }

    const [pythonValidation, python, ffmpeg, ffmpegCaptions, ffprobe, ytdlp] = await Promise.all([
      validatePython(resolvedPython, enginePath),
      check(resolvedPython),
      check(resolveBinary('ffmpeg'), '-version'),
      supportsCaptionFilter(),
      check(resolveBinary('ffprobe'), '-version'),
      check(resolveBinary('yt-dlp'))
    ])

    const result = {
      python,
      pythonDeps: pythonValidation.ok,
      pythonPath: resolvedPython,
      pythonError: pythonValidation.error,
      ffmpeg,
      ffmpegCaptions,
      ffprobe,
      ytdlp,
      engine: existsSync(join(enginePath, 'clip_engine', 'bridge_contract.py')),
      enginePath,
      bridgeRunner: existsSync(bridgePath),
      bridgePath
    }
    logger.info('system.checkTools', result)
    return result
  })
}

/** A YouTube video or Short, a Twitch VOD, a Kick VOD, or a Twitch or Kick channel page. */
export function isCreatorVideoUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    if (url.hostname === 'www.youtube.com') return /^\/(watch|shorts\/[\w-]{11})$/.test(url.pathname) && (url.pathname !== '/watch' || /^[\w-]{11}$/.test(url.searchParams.get('v') ?? ''))
    if (url.hostname === 'www.twitch.tv') return /^\/(videos\/\d{1,20}|[A-Za-z0-9_]{3,25})$/.test(url.pathname)
    if (url.hostname === 'kick.com') return /^\/[A-Za-z0-9_-]{2,30}(\/videos(\/[0-9a-f-]{36})?)?$/i.test(url.pathname)
    return false
  } catch {
    return false
  }
}

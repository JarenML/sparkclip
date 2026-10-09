import { shell } from 'electron'
import { logger } from '../logger'
import { fetchThumbnail, getJson, type FetchLike } from '../source-preview'
import { getClient, readCachedOverview } from './service'
import { sanitizeProviderText, ZernioApiError, type ZernioClient } from './client'
import { isPostUrl } from './posts-payload'
import { isZernioId, isZernioPlatform, type ZernioAccount, type ZernioAccountVideo, type ZernioAccountVideosPage } from '../../shared/zernio'

type JsonRecord = Record<string, unknown>

const PAGE_SIZE = 24
const MAX_PAGE = 200
/** Posts made through Zernio are few; one page of them goes with the first page of the platform's. */
const ZERNIO_POSTS_LIMIT = 100
/** Where post thumbnails and profile pictures are served; anything else shows a placeholder. */
const THUMBNAIL_HOSTS = [
  /^i\d?\.ytimg\.com$/,
  /\.tiktokcdn(-us|-eu)?\.com$/,
  /\.(byteimg|ibyteimg)\.com$/,
  /\.cdninstagram\.com$/,
  /\.fbcdn\.net$/,
  /^pbs\.twimg\.com$/,
  /^media\.licdn\.com$/,
  // Profile pictures; Zernio keeps its own copy of each.
  /^media\.zernio\.com$/,
  /^yt\d?\.(ggpht|googleusercontent)\.com$/,
  /^lh\d\.googleusercontent\.com$/
]
const MAX_THUMBNAILS = 300
const thumbnails = new Map<string, string | null>()
/**
 * Account -> the posts its last cover-repair sync returned. Zernio skips a sync
 * done in the last ~15 s and may then return no posts, so listings close
 * together share one.
 */
const repairSyncs = new Map<string, { at: number; posts: Promise<JsonRecord[]> }>()
const REPAIR_SYNC_REUSE_MS = 60_000
/** Post link -> cover image link from the platform's own oEmbed, when Zernio has none. */
const covers = new Map<string, string | null>()

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function str(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function date(value: unknown): string | null {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function mediaType(value: unknown): ZernioAccountVideo['mediaType'] {
  const type = typeof value === 'string' ? value.toLowerCase() : ''
  if (/video|reel|short/.test(type)) return 'video'
  if (/carousel|album/.test(type)) return 'carousel'
  if (/image|photo/.test(type)) return 'image'
  return null
}

function accountIdOf(value: unknown): string | null {
  return str(value) ?? str(asRecord(value)._id) ?? str(asRecord(value).id)
}

/** The first of `values` that is a usable string. */
function first(max: number, ...values: unknown[]): string | null {
  for (const value of values) {
    const found = str(value, max)
    if (found) return found
  }
  return null
}

/**
 * A post Zernio found on the platform (ExternalPostSummary). Zernio's field
 * names vary between endpoints, so the usual alternatives are accepted.
 */
function fromExternal(item: JsonRecord, accountPlatform: string | null): (ZernioAccountVideo & { thumbnailUrl: string | null }) | null {
  const target = asRecord(Array.isArray(item.platforms) ? item.platforms[0] : undefined)
  const media = asRecord(Array.isArray(item.mediaItems) ? item.mediaItems[0] : undefined)
  const platform = first(40, item.platform, target.platform, accountPlatform)
  const url = first(2048, item.platformPostUrl, item.permalink, item.url, item.postUrl, target.platformPostUrl)
  const id = first(200, item.platformPostId, item.externalPostId, item.postId, target.platformPostId, item._id, item.id) ?? url
  if (!platform || !id) return null
  const analytics = asRecord(item.analytics ?? item.metrics ?? item.stats)
  return {
    id,
    platform,
    url: isPostUrl(url, platform) ? url : null,
    caption: sanitizeProviderText(item.content ?? item.caption ?? item.text ?? item.title ?? item.description, 300) ?? null,
    publishedAt: date(item.publishedAt) ?? date(target.publishedAt) ?? date(item.createdAt) ?? date(item.timestamp),
    mediaType: mediaType(item.mediaType ?? media.type),
    thumbnail: null,
    thumbnailUrl: first(2048, item.thumbnailUrl, item.thumbnail, item.coverImageUrl, media.thumbnail, media.thumbnailUrl, media.coverUrl,
      media.previewUrl, target.thumbnailUrl, media.url),
    views: count(analytics.views ?? analytics.plays ?? analytics.videoViews),
    likes: count(analytics.likes),
    comments: count(analytics.comments),
    viaZernio: false
  }
}

/** A post published through Zernio, as it went to this account. */
function fromZernio(item: JsonRecord, accountId: string): (ZernioAccountVideo & { thumbnailUrl: null }) | null {
  const target = (Array.isArray(item.platforms) ? item.platforms.map(asRecord) : []).find((entry) => accountIdOf(entry.accountId) === accountId)
  const platform = str(target?.platform, 40)
  if (!target || !platform) return null
  const id = str(target.platformPostId) ?? str(item._id, 64)
  if (!id) return null
  const url = target.platformPostUrl
  const firstMedia = asRecord(Array.isArray(item.mediaItems) ? item.mediaItems[0] : undefined)
  return {
    id,
    platform,
    url: isPostUrl(url, platform) ? url : null,
    caption: sanitizeProviderText(item.content, 300) ?? sanitizeProviderText(item.title, 300) ?? null,
    publishedAt: date(target.publishedAt) ?? date(item.publishedAt),
    mediaType: mediaType(firstMedia.type),
    thumbnail: null,
    thumbnailUrl: null,
    views: null,
    likes: null,
    comments: null,
    viaZernio: true
  }
}

async function thumbnail(fetchImpl: FetchLike, url: string | null): Promise<string | null> {
  if (!url) return null
  if (thumbnails.has(url)) return thumbnails.get(url) ?? null
  const data = await fetchThumbnail(fetchImpl, url, THUMBNAIL_HOSTS)
  if (thumbnails.size >= MAX_THUMBNAILS) thumbnails.delete(thumbnails.keys().next().value as string)
  thumbnails.set(url, data)
  return data
}

/**
 * The cover the platform itself shows for a public post: TikTok's oEmbed
 * (no account or key needed) or YouTube's fixed thumbnail address.
 */
/** Why cards ended up without an image, counted per listing for the log. */
type CoverMiss = Record<string, number>

async function platformCover(fetchImpl: FetchLike, platform: string, url: string | null, miss: CoverMiss): Promise<string | null> {
  const note = (reason: string): null => { miss[reason] = (miss[reason] ?? 0) + 1; return null }
  if (!url || !isPostUrl(url, platform)) return note('noLink')
  if (platform === 'youtube') {
    const parsed = new URL(url)
    const id = parsed.hostname.endsWith('youtu.be') ? parsed.pathname.slice(1) : parsed.searchParams.get('v') ?? parsed.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1]
    return id && /^[\w-]{6,20}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null
  }
  if (platform !== 'tiktok') return note('otherPlatform')
  if (covers.has(url)) return covers.get(url) ?? null
  let cover: string | null = null
  try {
    cover = str(asRecord(await getJson(fetchImpl, `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`)).thumbnail_url, 2048)
    if (!cover) note('oembedNoCover')
  } catch (error) {
    // Private or deleted videos have no oEmbed; the card shows a placeholder.
    note(`oembed${(error instanceof Error ? error.message.match(/HTTP (\d+)/)?.[1] : null) ?? 'Failed'}`)
  }
  // Only answers are kept: TikTok sometimes turns oEmbed away for a while ("overload-protect").
  if (cover) {
    if (covers.size >= MAX_THUMBNAILS) covers.delete(covers.keys().next().value as string)
    covers.set(url, cover)
  }
  return cover
}

function hostOf(value: string | null): string | null {
  try { return value ? new URL(value).hostname : null } catch { return null }
}

/** Zernio's thumbnail, else the platform's own cover. */
/**
 * Zernio's thumbnail; then the fresh one a sync returns (TikTok's cover links
 * are signed and expire, so a saved one can stop working); then the
 * platform's own cover.
 */
async function cardImage(
  fetchImpl: FetchLike,
  video: ZernioAccountVideo & { thumbnailUrl: string | null },
  miss: CoverMiss,
  freshLinks: () => Promise<Map<string, string | null>>
): Promise<string | null> {
  const own = await thumbnail(fetchImpl, video.thumbnailUrl)
  if (own) return own
  // Only a saved link that stopped working is worth a sync; a post without one has nothing to refresh.
  const freshLink = video.thumbnailUrl ? (await freshLinks()).get(video.id) ?? null : null
  if (freshLink && freshLink !== video.thumbnailUrl) {
    const fresh = await thumbnail(fetchImpl, freshLink)
    if (fresh) return fresh
  }
  const cover = await platformCover(fetchImpl, video.platform, video.url, miss)
  if (!cover) return null
  return await thumbnail(fetchImpl, cover) ?? (miss.coverImageFailed = (miss.coverImageFailed ?? 0) + 1, null)
}

/**
 * A page of an account's posts, newest first: what Zernio found on the
 * platform, plus (on the first page) what was published through Zernio.
 * `refresh` asks Zernio to read the platform now instead of waiting for its sync.
 */
export async function listAccountVideos(
  accountId: unknown,
  page: unknown = 1,
  refresh: unknown = false,
  platform: unknown = null,
  deps: { client?: ZernioClient; fetchImpl?: FetchLike } = {}
): Promise<ZernioAccountVideosPage> {
  if (!isZernioId(accountId)) throw new Error('Invalid Zernio account')
  const pageNumber = Number.isInteger(page) && (page as number) >= 1 && (page as number) <= MAX_PAGE ? (page as number) : 1
  const client = deps.client ?? getClient()
  const fetchImpl = deps.fetchImpl ?? fetch

  // The sync answers with the posts it just read, in case the list doesn't have them yet.
  let synced: JsonRecord[] = []
  if (refresh === true && pageNumber === 1) {
    try {
      synced = await client.syncExternalPosts(accountId)
    } catch (error) {
      // The synced list is still worth showing; a disconnected account says so when listed.
      logger.warn('zernio.videos.syncFailed', { status: error instanceof ZernioApiError ? error.status : null })
      if (error instanceof ZernioApiError && (error.status === 401 || error.status === 429)) throw error
    }
  }

  const [external, viaZernio] = await Promise.all([
    client.listAccountPosts(accountId, 'external', pageNumber, PAGE_SIZE),
    pageNumber === 1 ? client.listAccountPosts(accountId, 'zernio', 1, ZERNIO_POSTS_LIMIT) : Promise.resolve({ posts: [], pages: null })
  ])

  const byId = new Map<string, ZernioAccountVideo & { thumbnailUrl: string | null }>()
  // Every post in the list is this account's, so its platform fills in a missing one.
  const accountPlatform = typeof platform === 'string' && isZernioPlatform(platform) ? platform : null
  for (const item of [...external.posts, ...synced]) {
    const video = fromExternal(item, accountPlatform)
    if (!video || !isZernioPlatform(video.platform)) continue
    const known = byId.get(video.id)
    // A post the sync just read carries the newest cover link.
    if (!known) byId.set(video.id, video)
    else if (video.thumbnailUrl) known.thumbnailUrl = video.thumbnailUrl
  }
  for (const item of viaZernio.posts) {
    const video = fromZernio(item, accountId)
    if (!video) continue
    // The platform's copy has the thumbnail and counts; it's still one SparkClip posted.
    const found = byId.get(video.id)
    if (found) found.viaZernio = true
    else byId.set(video.id, video)
  }

  const items = [...byId.values()].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
  const videos: ZernioAccountVideo[] = []
  const miss: CoverMiss = {}
  // Fresh cover links from a sync, asked for at most once, and only when a saved link fails.
  let freshRequest: Promise<Map<string, string | null>> | null = null
  const freshLinks = (): Promise<Map<string, string | null>> => {
    freshRequest ??= (async () => {
      const links = new Map<string, string | null>()
      let posts = synced
      if (posts.length === 0 && refresh !== true) {
        miss.resynced = 1
        let shared = repairSyncs.get(accountId)
        if (!shared || Date.now() - shared.at > REPAIR_SYNC_REUSE_MS) {
          shared = { at: Date.now(), posts: client.syncExternalPosts(accountId).catch(() => [] as JsonRecord[]) }
          repairSyncs.set(accountId, shared)
        }
        posts = await shared.posts
      }
      for (const item of posts) {
        const video = fromExternal(item, accountPlatform)
        if (video) links.set(video.id, video.thumbnailUrl)
      }
      return links
    })()
    return freshRequest
  }
  // Four thumbnails at a time.
  for (let i = 0; i < items.length; i += 4) {
    const batch = items.slice(i, i + 4)
    const images = await Promise.all(batch.map((item) => cardImage(fetchImpl, item, miss, freshLinks)))
    batch.forEach((item, j) => {
      // The CDN link stays in the main process; the window gets the image itself.
      const video: ZernioAccountVideo & { thumbnailUrl?: string | null } = { ...item, thumbnail: images[j] }
      delete video.thumbnailUrl
      videos.push(video)
    })
  }
  if (external.posts.length + synced.length > 0 && videos.length === 0) logger.warn('zernio.videos.unreadable', { listed: external.posts.length, synced: synced.length })
  // Field names only, to see where Zernio puts thumbnails on each platform.
  const sample = external.posts[0]
  if (sample) {
    logger.info('zernio.videos.listed', {
      shown: videos.length,
      withImage: videos.filter((v) => v.thumbnail).length,
      mediaFields: Object.keys(asRecord(Array.isArray(sample.mediaItems) ? sample.mediaItems[0] : undefined)).join(','),
      targetFields: Object.keys(asRecord(Array.isArray(sample.platforms) ? sample.platforms[0] : undefined)).join(','),
      thumbHost: hostOf(items.find((v) => v.thumbnailUrl)?.thumbnailUrl ?? null),
      mediaType: str(asRecord(Array.isArray(sample.mediaItems) ? sample.mediaItems[0] : undefined).type, 40),
      misses: Object.entries(miss).map(([reason, n]) => `${reason}:${n}`).join(',')
    })
  }
  return { videos, nextPage: external.pages !== null && pageNumber < external.pages && pageNumber < MAX_PAGE ? pageNumber + 1 : null }
}

/**
 * A connected account's profile picture as a data: URL, or null. The link is
 * read from the saved accounts, never taken from the window.
 */
export async function accountPicture(accountId: unknown, deps: { fetchImpl?: FetchLike; findAccount?: (id: string) => ZernioAccount | undefined } = {}): Promise<string | null> {
  if (!isZernioId(accountId)) return null
  const account = (deps.findAccount ?? ((id: string) => readCachedOverview()?.accounts.find((a) => a.id === id)))(accountId)
  return thumbnail(deps.fetchImpl ?? fetch, account?.pictureUrl ?? null)
}

/** Opens a post on its platform's own site; nothing else is opened. */
export async function openAccountVideo(url: unknown, platform: unknown): Promise<void> {
  if (typeof platform !== 'string' || !isPostUrl(url, platform)) throw new Error('This video doesn’t have a link yet.')
  await shell.openExternal(url)
}

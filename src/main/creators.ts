import { app, Notification } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CREATOR_PLATFORMS, CREATOR_PLATFORM_NAMES, FEED_PLATFORMS, creatorAccount, creatorLink,
  type Creator, type CreatorFeed, type CreatorInput, type CreatorPlatform, type FeedItem, type FeedPlatform, type YoutubeKind
} from '../shared/creators'
import { fetchThumbnail, getJson, readCapped, request, TWITCH_CLIENT_ID, type FetchLike } from './source-preview'

/**
 * Creators the user follows, stored in userData/creators.json, their latest
 * YouTube, Twitch and Kick videos read from each platform's public endpoints,
 * and desktop notifications when a followed creator posts or goes live.
 *
 * Every request goes to a fixed platform host with redirects refused and
 * responses size-capped (see source-preview). Thumbnails come back as data:
 * URLs so the renderer's CSP needs no new image hosts.
 */

interface StoredCreator extends Creator {
  /** YouTube channel id resolved from an @handle, so the page is read once. */
  youtubeChannelId?: string
  /**
   * Item ids listed when each platform's tab was last opened: anything else
   * that shows up later is "new". Ids, not dates: YouTube only says
   * "4 hours ago".
   */
  seen: Partial<Record<FeedPlatform, string[]>>
  /** Item ids already notified about, per platform. */
  known: Partial<Record<FeedPlatform, string[]>>
  /** Whether the creator was live at the last check, per platform. */
  live: Partial<Record<FeedPlatform, boolean>>
  /** Profile picture URL from the last platform that offered one. */
  avatarUrl?: string
}

const MAX_CREATORS = 200
const MAX_NAME = 80
const MAX_KNOWN = 100
const FEED_ITEMS = 15
const FEED_TTL_MS = 10 * 60 * 1000
const CHECK_EVERY_MS = 15 * 60 * 1000
const FIRST_CHECK_MS = 60 * 1000
const MAX_PAGE_BYTES = 4 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let cache: StoredCreator[] | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'creators.json')
}

function validStored(value: unknown): value is StoredCreator {
  if (!value || typeof value !== 'object') return false
  const c = value as StoredCreator
  return typeof c.id === 'string' && UUID.test(c.id) && typeof c.name === 'string' && c.name.length > 0 && c.name.length <= MAX_NAME &&
    typeof c.notify === 'boolean' && typeof c.createdAt === 'string' && !!c.links && typeof c.links === 'object' &&
    Object.entries(c.links).every(([platform, link]) =>
      CREATOR_PLATFORMS.includes(platform as CreatorPlatform) && typeof link === 'string' && creatorLink(platform as CreatorPlatform, link) === link)
}

function load(): StoredCreator[] {
  if (cache) return cache
  try {
    const data = JSON.parse(readFileSync(storePath(), 'utf8')) as { creators?: unknown[] }
    cache = (Array.isArray(data.creators) ? data.creators : []).filter(validStored).slice(0, MAX_CREATORS).map((c) => ({
      ...c,
      seen: c.seen && typeof c.seen === 'object' ? c.seen : {},
      known: c.known && typeof c.known === 'object' ? c.known : {},
      live: c.live && typeof c.live === 'object' ? c.live : {}
    }))
  } catch {
    cache = []
  }
  return cache
}

function save(): void {
  const path = storePath()
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, creators: load() }), { mode: 0o600 })
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
  }
}

function publicCreator(c: StoredCreator): Creator {
  return { id: c.id, name: c.name, links: { ...c.links }, notify: c.notify, createdAt: c.createdAt }
}

function find(id: unknown): StoredCreator {
  const creator = load().find((c) => c.id === id)
  if (!creator) throw new Error('This creator no longer exists.')
  return creator
}

export function listCreators(): Creator[] {
  return load().map(publicCreator).sort((a, b) => a.name.localeCompare(b.name))
}

/** Creates a creator, or updates one when `id` is given. Links are validated and made canonical. */
export function saveCreator(input: CreatorInput, id?: string): Creator {
  if (!input || typeof input !== 'object') throw new Error('Invalid creator')
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > MAX_NAME) throw new Error(`Give the creator a name of up to ${MAX_NAME} characters.`)
  const links: Partial<Record<CreatorPlatform, string>> = {}
  for (const platform of CREATOR_PLATFORMS) {
    const value = input.links?.[platform]
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) continue
    const link = typeof value === 'string' && value.length <= 300 ? creatorLink(platform, value) : null
    if (!link) throw new Error(`That doesn't look like a ${CREATOR_PLATFORM_NAMES[platform]} profile link.`)
    links[platform] = link
  }
  if (Object.keys(links).length === 0) throw new Error('Add at least one profile link.')
  const notify = input.notify === true
  const creators = load()
  if (id !== undefined) {
    const creator = find(id)
    if (creator.links.youtube !== links.youtube) delete creator.youtubeChannelId
    if (JSON.stringify(creator.links) !== JSON.stringify(links)) delete creator.avatarUrl
    for (const platform of FEED_PLATFORMS) {
      if (creator.links[platform] !== links[platform]) { delete creator.known[platform]; delete creator.live[platform]; delete creator.seen[platform] }
    }
    Object.assign(creator, { name, links, notify })
    clearFeeds(creator.id)
    save()
    return publicCreator(creator)
  }
  if (creators.length >= MAX_CREATORS) throw new Error(`You can follow up to ${MAX_CREATORS} creators.`)
  const creator: StoredCreator = { id: randomUUID(), name, links, notify, createdAt: new Date().toISOString(), seen: {}, known: {}, live: {} }
  creators.push(creator)
  save()
  return publicCreator(creator)
}

export function deleteCreator(id: unknown): boolean {
  const creators = load()
  const index = creators.findIndex((c) => c.id === id)
  if (index < 0) return false
  creators.splice(index, 1)
  clearFeeds(String(id))
  save()
  return true
}

export function setCreatorNotify(id: unknown, on: unknown): Creator {
  if (typeof on !== 'boolean') throw new Error('Invalid notification setting')
  const creator = find(id)
  creator.notify = on
  save()
  return publicCreator(creator)
}

/** A creator's stored profile link, for opening in the browser. */
export function creatorProfileLink(id: unknown, platform: unknown): string | null {
  const creator = find(id)
  return CREATOR_PLATFORMS.includes(platform as CreatorPlatform) ? creator.links[platform as CreatorPlatform] ?? null : null
}

/** Remembers what a platform's tab lists now: anything posted later shows as new. */
export function markCreatorViewed(id: unknown, platform: unknown): void {
  if (!FEED_PLATFORMS.includes(platform as FeedPlatform)) return
  const creator = find(id)
  const listed = [...feeds.entries()].filter(([key]) => key.startsWith(`${creator.id}:${platform}:`)).flatMap(([, { feed }]) => feed.items.map((item) => item.id))
  creator.seen[platform as FeedPlatform] = [...new Set([...listed, ...(creator.seen[platform as FeedPlatform] ?? [])])].slice(0, MAX_KNOWN * 2)
  save()
}

// ---------------------------------------------------------------------------
// Feeds

/** Videos read from a platform, newest first, and how to read the ones after them. */
interface RawPage {
  items: Omit<FeedItem, 'thumbnail' | 'isNew'>[]
  thumbnails: (string | null)[]
  next: (() => Promise<RawPage>) | null
}

interface RawFeed extends RawPage {
  live: CreatorFeed['live']
  avatar: string | null
}

/**
 * A list as shown, plus what was read but not shown yet (`rest`) and how to
 * read further (`next`): "Load more" shows the next FEED_ITEMS from those.
 */
interface FeedEntry {
  at: number
  feed: CreatorFeed
  rest: Omit<RawPage, 'next'>
  next: RawPage['next']
}

const feeds = new Map<string, FeedEntry>()
const images = new Map<string, string | null>()

function clearFeeds(id: string): void {
  for (const key of feeds.keys()) if (key.startsWith(`${id}:`)) feeds.delete(key)
}

async function text(fetchImpl: FetchLike, url: string, limit: number, headers: Record<string, string> = {}): Promise<string> {
  return new TextDecoder().decode(await readCapped(await request(fetchImpl, url, { headers }), limit))
}

function count(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null
}

function date(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Kick's "2026-09-23 03:31:33" is UTC.
  const ms = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const UNIT_MS: Record<string, number> = {
  second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000
}

/** "Streamed 4 hours ago" → that moment, roughly; null for anything else. */
export function relativeDate(value: string, now = Date.now()): string | null {
  const match = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(value)
  return match ? new Date(now - Number(match[1]) * UNIT_MS[match[2].toLowerCase()]).toISOString() : null
}

/** "3:05:23" → seconds. */
function clockSeconds(value: string): number | null {
  if (!/^\d{1,3}(:\d{2}){1,2}$/.test(value.trim())) return null
  return value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

/** "4 million views", "21,345 views", "12K watching" → a count. */
function spokenCount(value: string): number | null {
  const match = /([\d.,]+)\s*(thousand|million|billion|K|M|B)?\b/i.exec(value)
  if (!match) return /\bno views\b/i.test(value) ? 0 : null
  const scale = ({ thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, b: 1e9 } as Record<string, number>)[(match[2] ?? '').toLowerCase()] ?? 1
  const number = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(number) ? Math.round(number * scale) : null
}

function texts(value: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') Object.values(node).forEach(walk)
  }
  walk(value)
  return out
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

interface YoutubeItems extends Omit<RawPage, 'next'> {
  live: RawFeed['live']
  /** Token for the items after these, if there are more. */
  continuation: string | null
}

/**
 * Videos in a channel tab's grid, from the page or a continuation. Both the
 * current item format (lockupViewModel) and the older one (videoRenderer)
 * are read.
 */
function parseYoutubeItems(entries: unknown[], tab: YoutubeTab, now: number): YoutubeItems {
  const items: RawPage['items'] = []
  const thumbnails: (string | null)[] = []
  let live: RawFeed['live'] = null
  let continuation: string | null = null
  for (const entry of entries) {
    const token = field(entry, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token')
    if (typeof token === 'string' && token) continuation = token
    const content = field(entry, 'richItemRenderer', 'content')
    const lockup = field(content, 'lockupViewModel')
    const renderer = field(content, 'videoRenderer')
    let id: unknown, title: unknown, badge = '', meta: string[] = [], thumbs: unknown
    if (lockup && field(lockup, 'contentType') === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      id = field(lockup, 'contentId')
      title = field(lockup, 'metadata', 'lockupMetadataViewModel', 'title', 'content')
      const badges = list(field(lockup, 'contentImage', 'thumbnailViewModel', 'overlays')).map((o) => field(o, 'thumbnailBottomOverlayViewModel', 'badges'))
      badge = texts(badges).find((t) => /^(LIVE|UPCOMING|\d{1,3}(:\d{2}){1,2})$/i.test(t.trim()))?.trim() ?? ''
      meta = list(field(lockup, 'metadata', 'lockupMetadataViewModel', 'metadata', 'contentMetadataViewModel', 'metadataRows'))
        .flatMap((row) => list(field(row, 'metadataParts')))
        .map((part) => String(field(part, 'accessibilityLabel') ?? field(part, 'text', 'content') ?? ''))
      thumbs = field(lockup, 'contentImage', 'thumbnailViewModel', 'image', 'sources')
    } else if (renderer) {
      id = field(renderer, 'videoId')
      title = field(renderer, 'title', 'runs', '0', 'text') ?? field(renderer, 'title', 'simpleText')
      const length = field(renderer, 'lengthText', 'simpleText')
      badge = typeof length === 'string' ? length : JSON.stringify(field(renderer, 'badges') ?? '').includes('LIVE') ? 'LIVE' : ''
      meta = [texts(field(renderer, 'viewCountText')).join(''), texts(field(renderer, 'publishedTimeText')).join('')]
      thumbs = field(renderer, 'thumbnail', 'thumbnails')
    } else continue
    if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) continue
    const name = typeof title === 'string' && title.trim() ? title.trim() : tab === 'streams' ? 'Untitled stream' : 'Untitled video'
    const url = `https://www.youtube.com/watch?v=${id}`
    if (/^LIVE$/i.test(badge)) {
      live ??= { title: name, viewers: spokenCount(meta.find((m) => /watching/i.test(m)) ?? ''), url }
      continue
    }
    const publishedAt = meta.map((m) => relativeDate(m, now)).find(Boolean) ?? null
    // Scheduled streams have neither a length nor a date yet.
    if (/^UPCOMING$/i.test(badge) || (!publishedAt && clockSeconds(badge) == null)) continue
    const sources = list(thumbs)
    const thumbnail = field(sources[sources.length - 1], 'url')
    items.push({ id, url, title: name, publishedAt, durationSeconds: clockSeconds(badge), views: spokenCount(meta.find((m) => /view/i.test(m)) ?? '') })
    thumbnails.push(typeof thumbnail === 'string' ? thumbnail : null)
  }
  return { items, thumbnails, live, continuation }
}

/**
 * The videos on a YouTube channel tab page (Live or Videos), which embeds its
 * data as ytInitialData. A channel without the tab gets its Home page
 * instead, which lists nothing here.
 */
export function parseYoutubeTab(html: string, tab: YoutubeTab, now = Date.now()): YoutubeItems & {
  avatar: string | null
  channelId: string | null
  clientVersion: string | null
} {
  const channelId = (/"externalId":"(UC[\w-]{22})"/.exec(html) ?? /<meta itemprop="identifier" content="(UC[\w-]{22})"/.exec(html))?.[1] ?? null
  const avatar = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? null
  const clientVersion = /"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/.exec(html)?.[1] ?? null
  const json = /var ytInitialData = (\{[\s\S]*?\});<\/script>/.exec(html)?.[1]
  if (!json) throw new Error('YouTube page has no data')
  const data = JSON.parse(json) as unknown
  const selected = list(field(data, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs'))
    .map((renderer) => field(renderer, 'tabRenderer'))
    .find((renderer) => field(renderer, 'selected') === true)
  const selectedUrl = String(field(selected, 'endpoint', 'commandMetadata', 'webCommandMetadata', 'url') ?? '')
  const contents = selectedUrl.endsWith(`/${tab}`) ? list(field(selected, 'content', 'richGridRenderer', 'contents')) : []
  return { ...parseYoutubeItems(contents, tab, now), avatar, channelId, clientVersion }
}

type YoutubeTab = 'streams' | 'videos'

/** The grid's next items, from the endpoint YouTube's own page scrolls with. */
function youtubeNext(fetchImpl: FetchLike, tab: YoutubeTab, clientVersion: string | null, continuation: string | null): RawPage['next'] {
  if (!continuation || !clientVersion) return null
  return async () => {
    const data = await getJson(fetchImpl, 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en' } }, continuation })
    })
    const entries = list(field(data, 'onResponseReceivedActions')).flatMap((action) => list(field(action, 'appendContinuationItemsAction', 'continuationItems')))
    const page = parseYoutubeItems(entries, tab, Date.now())
    return { items: page.items, thumbnails: page.thumbnails, next: youtubeNext(fetchImpl, tab, clientVersion, page.continuation) }
  }
}

/** A channel tab: Live (its streams, and whether one is on now) or Videos (its uploads). */
async function youtubeTab(fetchImpl: FetchLike, creator: StoredCreator, tab: YoutubeTab): Promise<RawFeed> {
  const page = await text(fetchImpl, `${creator.links.youtube}/${tab}`, MAX_PAGE_BYTES, { 'Accept-Language': 'en' })
  const { channelId, clientVersion, continuation, ...feed } = parseYoutubeTab(page, tab)
  if (channelId && channelId !== creator.youtubeChannelId) {
    creator.youtubeChannelId = channelId
    save()
  }
  return { ...feed, next: youtubeNext(fetchImpl, tab, clientVersion, continuation) }
}

// Twitch refuses a second page of videos to anonymous clients, but one page
// of 100 holds every past broadcast it keeps.
const TWITCH_VIDEOS = 100

async function twitchFeed(fetchImpl: FetchLike, creator: StoredCreator): Promise<RawFeed> {
  const login = creatorAccount(creator.links.twitch as string)
  const data = await getJson(fetchImpl, 'https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($login: String!) { user(login: $login) { profileImageURL(width: 150) stream { title viewersCount }
        videos(first: ${TWITCH_VIDEOS}, sort: TIME, type: ARCHIVE) { edges { node { id title publishedAt lengthSeconds viewCount previewThumbnailURL(width: 320, height: 180) } } } } }`,
      variables: { login }
    })
  })
  const user = field(data, 'data', 'user')
  if (!user) throw new Error('Twitch channel not found')
  const edges = field(user, 'videos', 'edges')
  const nodes = (Array.isArray(edges) ? edges : []).map((edge) => field(edge, 'node')).filter((node) => /^\d{1,20}$/.test(String(field(node, 'id'))))
  const stream = field(user, 'stream')
  return {
    items: nodes.map((node) => ({
      id: String(field(node, 'id')),
      url: `https://www.twitch.tv/videos/${field(node, 'id')}`,
      title: typeof field(node, 'title') === 'string' ? String(field(node, 'title')) : 'Untitled stream',
      publishedAt: date(field(node, 'publishedAt')),
      durationSeconds: count(field(node, 'lengthSeconds')),
      views: count(field(node, 'viewCount'))
    })),
    thumbnails: nodes.map((node) => (typeof field(node, 'previewThumbnailURL') === 'string' ? String(field(node, 'previewThumbnailURL')) : null)),
    next: null,
    live: stream ? { title: String(field(stream, 'title') ?? ''), viewers: count(field(stream, 'viewersCount')), url: `https://www.twitch.tv/${login}` } : null,
    avatar: typeof field(user, 'profileImageURL') === 'string' ? String(field(user, 'profileImageURL')) : null
  }
}

/** Kick's API sometimes refuses or drops a request: try a few times. */
async function kickJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await getJson(fetchImpl, url)
    } catch (error) {
      last = error
      if (/HTTP 404/.test(String((error as Error)?.message))) break
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
    }
  }
  throw last
}

async function kickFeed(fetchImpl: FetchLike, creator: StoredCreator): Promise<RawFeed> {
  const slug = creatorAccount(creator.links.kick as string)
  const channel = await kickJson(fetchImpl, `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`)
  const vods = await kickJson(fetchImpl, `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`)
  const list = (Array.isArray(vods) ? vods : []).filter((vod) => /^[0-9a-f-]{36}$/i.test(String(field(vod, 'video', 'uuid'))))
  const stream = field(channel, 'livestream')
  const thumbnail = (vod: unknown): string | null => {
    const value = field(vod, 'thumbnail')
    const src = typeof value === 'string' ? value : field(value, 'src')
    return typeof src === 'string' ? src : null
  }
  return {
    items: list.map((vod) => ({
      id: String(field(vod, 'video', 'uuid')),
      url: `https://kick.com/${slug}/videos/${field(vod, 'video', 'uuid')}`,
      title: typeof field(vod, 'session_title') === 'string' ? String(field(vod, 'session_title')) : 'Untitled stream',
      publishedAt: date(field(vod, 'start_time')),
      // Kick reports milliseconds.
      durationSeconds: count(field(vod, 'duration')) != null ? Math.round((count(field(vod, 'duration')) as number) / 1000) : null,
      views: count(field(vod, 'views'))
    })),
    thumbnails: list.map(thumbnail),
    // Every VOD Kick keeps comes in this one response.
    next: null,
    live: stream ? { title: String(field(stream, 'session_title') ?? ''), viewers: count(field(stream, 'viewer_count')), url: `https://kick.com/${slug}` } : null,
    avatar: typeof field(channel, 'user', 'profile_pic') === 'string' ? String(field(channel, 'user', 'profile_pic')) : null
  }
}

// YouTube reads the Live tab: streams are what gets clipped. Uploads stay
// available as a second YouTube list.
const READERS: Record<FeedPlatform, (fetchImpl: FetchLike, creator: StoredCreator) => Promise<RawFeed>> = {
  youtube: (fetchImpl, creator) => youtubeTab(fetchImpl, creator, 'streams'), twitch: twitchFeed, kick: kickFeed
}

async function image(fetchImpl: FetchLike, url: string | null): Promise<string | null> {
  if (!url) return null
  if (images.has(url)) return images.get(url) ?? null
  const data = await fetchThumbnail(fetchImpl, url)
  if (images.size > 400) images.delete(images.keys().next().value as string)
  images.set(url, data)
  return data
}

interface FeedList {
  creator: StoredCreator
  feedPlatform: FeedPlatform
  kindField: { kind?: YoutubeKind }
  key: string
  read: (fetchImpl: FetchLike, creator: StoredCreator) => Promise<RawFeed>
  withNew: (feed: CreatorFeed) => CreatorFeed
}

/** Which list a request names, and how to read it. */
function feedList(id: unknown, platform: unknown, kind: unknown): FeedList {
  if (!FEED_PLATFORMS.includes(platform as FeedPlatform)) throw new Error('Unsupported platform')
  const creator = find(id)
  const feedPlatform = platform as FeedPlatform
  if (!creator.links[feedPlatform]) throw new Error(`This creator has no ${CREATOR_PLATFORM_NAMES[feedPlatform]} link.`)
  const youtubeKind: YoutubeKind | undefined = feedPlatform === 'youtube' ? (kind === 'uploads' ? 'uploads' : 'lives') : undefined
  const seen = creator.seen[feedPlatform]
  return {
    creator,
    feedPlatform,
    kindField: youtubeKind ? { kind: youtubeKind } : {},
    key: `${creator.id}:${feedPlatform}:${youtubeKind ?? ''}`,
    read: youtubeKind === 'uploads' ? (f: FetchLike, c: StoredCreator) => youtubeTab(f, c, 'videos') : READERS[feedPlatform],
    // Only the first page can hold something new (older pages come from "Load more"). A list none of
    // whose items were seen was never opened (YouTube's other list): nothing in it is new.
    withNew: (feed: CreatorFeed): CreatorFeed => {
      const opened = !!seen && feed.items.some((item) => seen.includes(item.id))
      return { ...feed, items: feed.items.map((item, i) => ({ ...item, isNew: opened && i < FEED_ITEMS && !seen.includes(item.id) })) }
    }
  }
}

/** Items with their thumbnails as data: URLs, four requests at a time. */
async function withThumbnails(fetchImpl: FetchLike, page: Omit<RawPage, 'next'>): Promise<FeedItem[]> {
  const thumbnails: (string | null)[] = []
  for (let i = 0; i < page.items.length; i += 4) {
    thumbnails.push(...await Promise.all(page.thumbnails.slice(i, i + 4).map((url) => image(fetchImpl, url))))
  }
  return page.items.map((item, i) => ({ ...item, thumbnail: thumbnails[i] ?? null, isNew: false }))
}

/** A creator's latest videos on one platform, cached for a few minutes. YouTube lists live streams unless `kind` is 'uploads'. */
export async function getCreatorFeed(fetchImpl: FetchLike, id: unknown, platform: unknown, refresh = false, kind: unknown = 'lives'): Promise<CreatorFeed> {
  const { creator, feedPlatform, kindField, key, read, withNew } = feedList(id, platform, kind)
  const cached = feeds.get(key)
  if (cached && !refresh && Date.now() - cached.at < FEED_TTL_MS) return withNew(cached.feed)
  try {
    const raw = await read(fetchImpl, creator)
    if (raw.avatar && raw.avatar !== creator.avatarUrl) {
      creator.avatarUrl = raw.avatar
      save()
    }
    const rest = { items: raw.items.slice(FEED_ITEMS), thumbnails: raw.thumbnails.slice(FEED_ITEMS) }
    const feed: CreatorFeed = {
      platform: feedPlatform,
      ...kindField,
      items: await withThumbnails(fetchImpl, { items: raw.items.slice(0, FEED_ITEMS), thumbnails: raw.thumbnails.slice(0, FEED_ITEMS) }),
      hasMore: rest.items.length > 0 || !!raw.next,
      live: raw.live,
      avatar: await image(fetchImpl, raw.avatar ?? creator.avatarUrl ?? null),
      fetchedAt: new Date().toISOString(),
      error: null
    }
    feeds.set(key, { at: Date.now(), feed, rest, next: raw.next })
    return withNew(feed)
  } catch {
    const fallback = cached?.feed
    return {
      ...(fallback ? withNew(fallback) : { platform: feedPlatform, ...kindField, items: [], hasMore: false, live: null, avatar: null, fetchedAt: new Date().toISOString() }),
      error: `Couldn't load ${CREATOR_PLATFORM_NAMES[feedPlatform]} right now. Check your connection and try again.`
    }
  }
}

/** The same list with the next FEED_ITEMS older videos added, reading further pages as needed. */
export async function getMoreCreatorFeed(fetchImpl: FetchLike, id: unknown, platform: unknown, kind: unknown = 'lives'): Promise<CreatorFeed> {
  const { key, withNew } = feedList(id, platform, kind)
  const entry = feeds.get(key)
  if (!entry) throw new Error('This list is out of date. Refresh it and try again.')
  const listed = new Set([...entry.feed.items, ...entry.rest.items].map((item) => item.id))
  try {
    while (entry.rest.items.length < FEED_ITEMS && entry.next) {
      const page = await entry.next()
      page.items.forEach((item, i) => {
        if (listed.has(item.id)) return
        listed.add(item.id)
        entry.rest.items.push(item)
        entry.rest.thumbnails.push(page.thumbnails[i] ?? null)
      })
      entry.next = page.next
    }
  } catch {
    throw new Error(`Couldn't load more from ${CREATOR_PLATFORM_NAMES[entry.feed.platform]} right now. Try again in a moment.`)
  }
  const batch = { items: entry.rest.items.splice(0, FEED_ITEMS), thumbnails: entry.rest.thumbnails.splice(0, FEED_ITEMS) }
  entry.feed = {
    ...entry.feed,
    items: [...entry.feed.items, ...await withThumbnails(fetchImpl, batch)],
    hasMore: entry.rest.items.length > 0 || !!entry.next
  }
  return withNew(entry.feed)
}

/** A creator's profile picture as a data: URL, once a feed has offered one. */
export async function getCreatorAvatar(fetchImpl: FetchLike, id: unknown): Promise<string | null> {
  return image(fetchImpl, find(id).avatarUrl ?? null)
}

// ---------------------------------------------------------------------------
// Notifications

let timers: NodeJS.Timeout[] = []
let checking = false

export interface CreatorUpdate {
  creatorId: string
  title: string
  body: string
}

/**
 * Checks followed creators with notifications on. The first check of a
 * platform only records what's there; later ones report new videos and a
 * stream going live. Returns the updates to announce.
 */
export async function checkCreators(fetchImpl: FetchLike): Promise<CreatorUpdate[]> {
  if (checking) return []
  checking = true
  const updates: CreatorUpdate[] = []
  try {
    for (const creator of load().filter((c) => c.notify)) {
      for (const platform of FEED_PLATFORMS) {
        if (!creator.links[platform]) continue
        let raw: RawFeed
        try {
          raw = await READERS[platform](fetchImpl, creator)
        } catch {
          continue
        }
        const name = CREATOR_PLATFORM_NAMES[platform]
        const known = creator.known[platform]
        const latest = raw.items.slice(0, FEED_ITEMS)
        const fresh = known ? latest.filter((item) => !known.includes(item.id)) : []
        // Every list read here is of streams (YouTube's Live tab, Twitch and Kick VODs).
        if (fresh.length === 1) updates.push({ creatorId: creator.id, title: `New ${name} stream from ${creator.name}`, body: fresh[0].title })
        else if (fresh.length > 1) updates.push({ creatorId: creator.id, title: `${fresh.length} new ${name} streams from ${creator.name}`, body: fresh[0].title })
        creator.known[platform] = [...new Set([...latest.map((item) => item.id), ...(known ?? [])])].slice(0, MAX_KNOWN)
        if (raw.live && creator.live[platform] === false) updates.push({ creatorId: creator.id, title: `${creator.name} is live on ${name}`, body: raw.live.title })
        creator.live[platform] = !!raw.live
      }
    }
    save()
  } finally {
    checking = false
  }
  return updates
}

/** Checks in the background and shows a desktop notification per update; clicking one opens the creator. */
export function startCreatorWatcher(fetchImpl: FetchLike, onOpen: (creatorId: string) => void): void {
  stopCreatorWatcher()
  const run = (): void => {
    if (!load().some((c) => c.notify)) return
    void checkCreators(fetchImpl).then((updates) => {
      if (!Notification.isSupported()) return
      for (const update of updates) {
        const note = new Notification({ title: update.title, body: update.body.slice(0, 200) })
        note.on('click', () => onOpen(update.creatorId))
        note.show()
      }
    }).catch(() => { /* The next check retries. */ })
  }
  timers = [setTimeout(run, FIRST_CHECK_MS), setInterval(run, CHECK_EVERY_MS)]
  for (const t of timers) t.unref()
}

export function stopCreatorWatcher(): void {
  for (const t of timers) clearTimeout(t)
  timers = []
}

/** Test hook: forget the in-memory store and feeds. */
export function resetCreatorsForTests(): void {
  cache = null
  feeds.clear()
  images.clear()
}

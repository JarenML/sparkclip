import { app, Notification } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CREATOR_PLATFORMS, CREATOR_PLATFORM_NAMES, FEED_PLATFORMS, creatorAccount, creatorLink,
  type Creator, type CreatorFeed, type CreatorInput, type CreatorPlatform, type FeedItem, type FeedPlatform
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
  /** When each platform's tab was last opened: later uploads are "new". */
  viewedAt: Partial<Record<FeedPlatform, string>>
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
const MAX_FEED_BYTES = 2 * 1024 * 1024
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
      viewedAt: c.viewedAt && typeof c.viewedAt === 'object' ? c.viewedAt : {},
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
      if (creator.links[platform] !== links[platform]) { delete creator.known[platform]; delete creator.live[platform]; delete creator.viewedAt[platform] }
    }
    Object.assign(creator, { name, links, notify })
    clearFeeds(creator.id)
    save()
    return publicCreator(creator)
  }
  if (creators.length >= MAX_CREATORS) throw new Error(`You can follow up to ${MAX_CREATORS} creators.`)
  const creator: StoredCreator = { id: randomUUID(), name, links, notify, createdAt: new Date().toISOString(), viewedAt: {}, known: {}, live: {} }
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

/** Remembers that a platform's tab was seen now: later uploads show as new. */
export function markCreatorViewed(id: unknown, platform: unknown): void {
  if (!FEED_PLATFORMS.includes(platform as FeedPlatform)) return
  const creator = find(id)
  creator.viewedAt[platform as FeedPlatform] = new Date().toISOString()
  save()
}

// ---------------------------------------------------------------------------
// Feeds

interface RawFeed {
  items: Omit<FeedItem, 'thumbnail' | 'isNew'>[]
  thumbnails: (string | null)[]
  live: CreatorFeed['live']
  avatar: string | null
}

const feeds = new Map<string, { at: number; feed: CreatorFeed }>()
const images = new Map<string, string | null>()

function clearFeeds(id: string): void {
  for (const key of feeds.keys()) if (key.startsWith(`${id}:`)) feeds.delete(key)
}

async function text(fetchImpl: FetchLike, url: string, limit: number, headers: Record<string, string> = {}): Promise<string> {
  return new TextDecoder().decode(await readCapped(await request(fetchImpl, url, { headers }), limit))
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function tag(xml: string, pattern: RegExp): string | null {
  const match = pattern.exec(xml)
  return match ? decodeXml(match[1]).trim() : null
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

/** Parses a YouTube channel's Atom feed (its 15 latest uploads). */
export function parseYoutubeFeed(xml: string): RawFeed['items'] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, FEED_ITEMS).flatMap(([, entry]) => {
    const id = tag(entry, /<yt:videoId>([^<]+)<\/yt:videoId>/)
    if (!id || !/^[\w-]{11}$/.test(id)) return []
    const link = tag(entry, /<link rel="alternate" href="([^"]+)"/)
    const url = link && /^https:\/\/www\.youtube\.com\/(watch\?v=|shorts\/)[\w-]{11}$/.test(link) ? link : `https://www.youtube.com/watch?v=${id}`
    return [{
      id, url,
      title: tag(entry, /<title>([\s\S]*?)<\/title>/) ?? 'Untitled video',
      publishedAt: date(tag(entry, /<published>([^<]+)<\/published>/)),
      durationSeconds: null,
      views: count(tag(entry, /<media:statistics views="(\d+)"/))
    }]
  })
}

/** Thumbnail URLs for the parsed YouTube entries, in the same order. */
function youtubeThumbnails(xml: string): (string | null)[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, FEED_ITEMS)
    .filter(([, entry]) => /<yt:videoId>[\w-]{11}<\/yt:videoId>/.test(entry))
    .map(([, entry]) => tag(entry, /<media:thumbnail url="([^"]+)"/))
}

async function youtubeFeed(fetchImpl: FetchLike, creator: StoredCreator): Promise<RawFeed> {
  const link = creator.links.youtube as string
  let channelId = /\/channel\/(UC[\w-]{22})$/.exec(link)?.[1] ?? creator.youtubeChannelId
  let avatar: string | null = null
  if (!channelId) {
    // An @handle has no feed of its own: its page names the channel.
    const page = await text(fetchImpl, link, MAX_PAGE_BYTES, { 'Accept-Language': 'en' })
    channelId = (/"externalId":"(UC[\w-]{22})"/.exec(page) ?? /<meta itemprop="identifier" content="(UC[\w-]{22})"/.exec(page))?.[1]
    if (!channelId) throw new Error('YouTube channel not found')
    avatar = /<meta property="og:image" content="([^"]+)"/.exec(page)?.[1] ?? null
    creator.youtubeChannelId = channelId
    save()
  }
  const xml = await text(fetchImpl, `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, MAX_FEED_BYTES)
  return { items: parseYoutubeFeed(xml), thumbnails: youtubeThumbnails(xml), live: null, avatar }
}

async function twitchFeed(fetchImpl: FetchLike, creator: StoredCreator): Promise<RawFeed> {
  const login = creatorAccount(creator.links.twitch as string)
  const data = await getJson(fetchImpl, 'https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($login: String!) { user(login: $login) { profileImageURL(width: 150) stream { title viewersCount }
        videos(first: ${FEED_ITEMS}, sort: TIME, type: ARCHIVE) { edges { node { id title publishedAt lengthSeconds viewCount previewThumbnailURL(width: 320, height: 180) } } } } }`,
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
  const list = (Array.isArray(vods) ? vods : []).filter((vod) => /^[0-9a-f-]{36}$/i.test(String(field(vod, 'video', 'uuid')))).slice(0, FEED_ITEMS)
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
    live: stream ? { title: String(field(stream, 'session_title') ?? ''), viewers: count(field(stream, 'viewer_count')), url: `https://kick.com/${slug}` } : null,
    avatar: typeof field(channel, 'user', 'profile_pic') === 'string' ? String(field(channel, 'user', 'profile_pic')) : null
  }
}

const READERS: Record<FeedPlatform, (fetchImpl: FetchLike, creator: StoredCreator) => Promise<RawFeed>> = {
  youtube: youtubeFeed, twitch: twitchFeed, kick: kickFeed
}

async function image(fetchImpl: FetchLike, url: string | null): Promise<string | null> {
  if (!url) return null
  if (images.has(url)) return images.get(url) ?? null
  const data = await fetchThumbnail(fetchImpl, url)
  if (images.size > 400) images.delete(images.keys().next().value as string)
  images.set(url, data)
  return data
}

/** A creator's latest videos on one platform, cached for a few minutes. */
export async function getCreatorFeed(fetchImpl: FetchLike, id: unknown, platform: unknown, refresh = false): Promise<CreatorFeed> {
  if (!FEED_PLATFORMS.includes(platform as FeedPlatform)) throw new Error('Unsupported platform')
  const creator = find(id)
  const feedPlatform = platform as FeedPlatform
  if (!creator.links[feedPlatform]) throw new Error(`This creator has no ${CREATOR_PLATFORM_NAMES[feedPlatform]} link.`)
  const key = `${creator.id}:${feedPlatform}`
  const cached = feeds.get(key)
  const viewed = creator.viewedAt[feedPlatform]
  const withNew = (feed: CreatorFeed): CreatorFeed => ({
    ...feed,
    items: feed.items.map((item) => ({ ...item, isNew: !!viewed && !!item.publishedAt && item.publishedAt > viewed }))
  })
  if (cached && !refresh && Date.now() - cached.at < FEED_TTL_MS) return withNew(cached.feed)
  try {
    const raw = await READERS[feedPlatform](fetchImpl, creator)
    const thumbnails: (string | null)[] = []
    for (let i = 0; i < raw.items.length; i += 4) {
      thumbnails.push(...await Promise.all(raw.thumbnails.slice(i, i + 4).map((url) => image(fetchImpl, url))))
    }
    if (raw.avatar && raw.avatar !== creator.avatarUrl) {
      creator.avatarUrl = raw.avatar
      save()
    }
    const feed: CreatorFeed = {
      platform: feedPlatform,
      items: raw.items.map((item, i) => ({ ...item, thumbnail: thumbnails[i] ?? null, isNew: false })),
      live: raw.live,
      avatar: await image(fetchImpl, raw.avatar ?? creator.avatarUrl ?? null),
      fetchedAt: new Date().toISOString(),
      error: null
    }
    feeds.set(key, { at: Date.now(), feed })
    return withNew(feed)
  } catch {
    const fallback = cached?.feed
    return {
      ...(fallback ? withNew(fallback) : { platform: feedPlatform, items: [], live: null, avatar: null, fetchedAt: new Date().toISOString() }),
      error: `Couldn't load ${CREATOR_PLATFORM_NAMES[feedPlatform]} right now. Check your connection and try again.`
    }
  }
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
        const fresh = known ? raw.items.filter((item) => !known.includes(item.id)) : []
        if (fresh.length === 1) updates.push({ creatorId: creator.id, title: `${creator.name} posted on ${name}`, body: fresh[0].title })
        else if (fresh.length > 1) updates.push({ creatorId: creator.id, title: `${creator.name} posted ${fresh.length} videos on ${name}`, body: fresh[0].title })
        creator.known[platform] = [...new Set([...raw.items.map((item) => item.id), ...(known ?? [])])].slice(0, MAX_KNOWN)
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

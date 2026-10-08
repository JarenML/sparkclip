import { useCallback, useEffect, useRef, useState } from 'react'
import { Film, RefreshCw } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage } from '../lib/utils'
import type { ZernioAccount, ZernioAccountVideo } from '../../shared/zernio'
import { PlatformIcon, platformName } from './PlatformIcon'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { EmptyState } from './ui/EmptyState'
import { Skeleton } from './ui/Skeleton'

/** Reopening an account within this long shows what was loaded without asking Zernio again. */
const REUSE_FOR_MS = 5 * 60_000
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2'
/** Platforms whose posts are mostly vertical video. */
const VERTICAL = new Set(['tiktok', 'instagram', 'threads'])

interface Loaded {
  videos: ZernioAccountVideo[]
  nextPage: number | null
  loadedAt: number
}

// Per account, for this session only; Refresh always reads Zernio again.
const loadedVideos = new Map<string, Loaded>()

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

function shortDate(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

/** The account's posts, newest first, from Zernio: found on the platform or posted through Zernio. */
export function AccountVideos({ account }: { account: ZernioAccount }): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(() => loadedVideos.get(account.id) ?? null)
  const [loading, setLoading] = useState<'first' | 'more' | 'refresh' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = useRef(account.id)
  const name = platformName(account.platform)

  const load = useCallback(async (page: number, mode: 'first' | 'more' | 'refresh'): Promise<void> => {
    const accountId = account.id
    setLoading(mode)
    setError(null)
    try {
      const result = await getApi().zernio.videos.list(accountId, page, mode === 'refresh', account.platform)
      if (current.current !== accountId) return
      const before = page === 1 ? [] : loadedVideos.get(accountId)?.videos ?? []
      const seen = new Set(before.map((video) => video.id))
      const next: Loaded = { videos: [...before, ...result.videos.filter((video) => !seen.has(video.id))], nextPage: result.nextPage, loadedAt: Date.now() }
      loadedVideos.set(accountId, next)
      setData(next)
    } catch (err) {
      if (current.current === accountId) setError(errorMessage(err, 'Could not load this account’s videos.'))
    } finally {
      if (current.current === accountId) setLoading(null)
    }
  }, [account.id, account.platform])

  useEffect(() => {
    current.current = account.id
    const cached = loadedVideos.get(account.id) ?? null
    setData(cached)
    setError(null)
    if (!cached || Date.now() - cached.loadedAt > REUSE_FOR_MS) void load(1, 'first')
  }, [account.id, load])

  const open = (video: ZernioAccountVideo): void => {
    if (video.url) void getApi().zernio.videos.open(video.url, video.platform).catch(() => {})
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-xs text-ink-muted">
          {data ? (
            <><span className="font-mono tabular text-ink">{data.videos.length}</span>{data.nextPage ? '+' : ''} {data.videos.length === 1 ? 'post' : 'posts'} · Zernio reads {name} about every 90 minutes</>
          ) : 'Loading from Zernio…'}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw className={cn('h-3.5 w-3.5', loading === 'refresh' && 'animate-spin')} />}
          onClick={() => void load(1, 'refresh')}
          disabled={Boolean(loading)}
          title={`Ask Zernio to read ${name} now`}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <Callout tone={data ? 'warning' : 'danger'} role="alert" action={<Button size="sm" variant="ghost" onClick={() => void load(1, data ? 'refresh' : 'first')}>Try again</Button>}>
          {error}
        </Callout>
      )}

      {!data && loading && (
        <ul className={GRID} aria-busy="true" aria-label="Loading videos">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="glass-tile overflow-hidden rounded-xl">
              <Skeleton className={cn('w-full rounded-none', VERTICAL.has(account.platform) ? 'aspect-[9/16]' : 'aspect-video')} />
              <div className="space-y-1.5 p-2"><Skeleton className="h-2.5 w-full" /><Skeleton className="h-2 w-16" /></div>
            </li>
          ))}
        </ul>
      )}

      {data && data.videos.length === 0 && !loading && (
        <EmptyState
          icon={<Film />}
          title="No videos yet"
          description={`Nothing from this ${name} account has reached Zernio yet. New uploads show up within about 90 minutes, or right away with Refresh.`}
        />
      )}

      {data && data.videos.length > 0 && (
        <ul aria-label="Videos" className={GRID}>
          {data.videos.map((video) => <VideoCard key={video.id} video={video} onOpen={() => open(video)} />)}
        </ul>
      )}

      {data?.nextPage && (
        <div className="flex justify-center">
          <Button onClick={() => void load(data.nextPage!, 'more')} loading={loading === 'more'} disabled={Boolean(loading)}>Load more</Button>
        </div>
      )}
    </div>
  )
}

function VideoCard({ video, onOpen }: { video: ZernioAccountVideo; onOpen: () => void }): React.JSX.Element {
  const name = platformName(video.platform)
  const stats = [
    shortDate(video.publishedAt),
    video.views !== null ? `${compact.format(video.views)} views` : null,
    video.views === null && video.likes !== null ? `${compact.format(video.likes)} likes` : null
  ].filter(Boolean).join(' · ')
  return (
    <li data-video={video.id}>
      <button
        type="button"
        onClick={onOpen}
        disabled={!video.url}
        aria-label={`${video.caption ?? 'Untitled post'}${video.url ? `, open on ${name}` : ''}`}
        title={video.url ? `Open on ${name}` : 'No link yet'}
        className={cn('glass-tile group/video flex w-full flex-col overflow-hidden rounded-xl text-left', video.url ? 'glass-tile-hover' : 'cursor-default')}
      >
        <div className={cn('relative w-full overflow-hidden bg-white/[0.04]', VERTICAL.has(video.platform) ? 'aspect-[9/16]' : 'aspect-video')}>
          {video.thumbnail ? (
            <img src={video.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-200 group-hover/video:scale-[1.02]" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <PlatformIcon platform={video.platform} className="h-9 w-9 rounded-lg opacity-60" />
            </div>
          )}
          <div className="absolute inset-x-1.5 top-1.5 flex justify-between gap-1">
            {video.viaZernio ? <span className="rounded-full bg-black/60 px-1.5 text-2xs font-medium leading-4 text-white backdrop-blur" title="Posted through Zernio">SparkClip</span> : <span />}
            {video.mediaType && video.mediaType !== 'video' && (
              <span className="rounded-full bg-black/60 px-1.5 text-2xs leading-4 text-white backdrop-blur">{video.mediaType === 'image' ? 'Photo' : 'Carousel'}</span>
            )}
          </div>
        </div>
        <div className="min-w-0 space-y-0.5 p-2">
          <p className={cn('line-clamp-2 text-xs leading-4', video.caption ? 'text-ink' : 'text-ink-subtle')} data-selectable>{video.caption ?? 'No caption'}</p>
          {stats && <p className="truncate text-2xs text-ink-subtle">{stats}</p>}
        </div>
      </button>
    </li>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, BellOff, ExternalLink, Pencil, Plus, Radio, RefreshCw, Scissors, Trash2, UserRound } from 'lucide-react'
import { CREATOR_PLATFORMS, CREATOR_PLATFORM_NAMES, FEED_PLATFORMS, creatorAccount, type Creator, type CreatorFeed, type FeedItem, type FeedPlatform, type YoutubeKind } from '../../shared/creators'
import { BackLink } from '../components/ClipList'
import { CreatorDialog } from '../components/CreatorDialog'
import { CreatorIcon } from '../components/CreatorIcon'
import type { Page as AppPage } from '../components/Sidebar'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Segmented } from '../components/ui/Segmented'
import { Skeleton } from '../components/ui/Skeleton'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatRelativeDate, formatTimecode } from '../lib/utils'
import { useCreatorViewStore } from '../store/use-creator-view-store'
import { useDraftStore } from '../store/use-draft-store'

function views(count: number | null): string | null {
  if (count == null) return null
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M views`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K views`
  return `${count} view${count === 1 ? '' : 's'}`
}

function Avatar({ src, name, className }: { src: string | null; name: string; className?: string }): React.JSX.Element {
  return src ? (
    <img src={src} alt="" className={cn('shrink-0 rounded-full object-cover', className)} />
  ) : (
    <span aria-hidden className={cn('flex shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-semibold text-ink-muted', className)}>
      {name.trim().charAt(0).toUpperCase() || <UserRound className="h-4 w-4" />}
    </span>
  )
}

function useAvatar(id: string): string | null {
  const [avatar, setAvatar] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getApi().creators.avatar(id).then((src) => { if (!cancelled) setAvatar(src) }).catch(() => {})
    return () => { cancelled = true }
  }, [id])
  return avatar
}

/**
 * Creators the user follows: a profile per creator that gathers their
 * YouTube, Twitch and Kick uploads, with links to their other networks.
 */
export function CreatorsPage({ onNavigate }: { onNavigate: (page: AppPage) => void }): React.JSX.Element {
  const [creators, setCreators] = useState<Creator[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Creator | 'new' | null>(null)
  const openId = useCreatorViewStore((s) => s.openId)
  const open = useCreatorViewStore((s) => s.open)

  const load = useCallback(async () => {
    try {
      setCreators(await getApi().creators.list())
    } catch (err) {
      setCreators((current) => current ?? [])
      setError(errorMessage(err, 'Could not load your creators.'))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const closeEditor = useCallback(() => setEditing(null), [])
  const saved = (creator: Creator): void => {
    setEditing(null)
    void load()
    open(creator.id)
  }

  const current = openId ? creators?.find((creator) => creator.id === openId) ?? null : null
  if (current) {
    return (
      <>
        <CreatorProfile
          creator={current}
          onBack={() => open(null)}
          onEdit={() => setEditing(current)}
          onChanged={() => { void load() }}
          onDeleted={() => { open(null); void load() }}
          onNavigate={onNavigate}
        />
        {editing && <CreatorDialog creator={editing === 'new' ? undefined : editing} onSaved={saved} onClose={closeEditor} />}
      </>
    )
  }

  return (
    <Page width="wide">
      <PageHeader
        eyebrow="Studio"
        title="Creators"
        description="Follow creators and see what they post on YouTube, Twitch and Kick in one place."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add creator</Button>}
      />
      {error && <Callout tone="danger" className="mt-4" onDismiss={() => setError(null)}>{error}</Callout>}
      <div className="mt-5">
        {creators === null ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
          </div>
        ) : creators.length === 0 ? (
          <EmptyState
            icon={<UserRound />}
            title="No creators yet"
            description="Add the creators you clip, with their YouTube, Twitch or Kick channels, to see their latest videos here and get notified when they post or go live."
            action={<Button variant="primary" size="lg" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Add your first creator</Button>}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {creators.map((creator) => <CreatorCard key={creator.id} creator={creator} onOpen={() => open(creator.id)} />)}
          </div>
        )}
      </div>
      {editing && <CreatorDialog creator={editing === 'new' ? undefined : editing} onSaved={saved} onClose={closeEditor} />}
    </Page>
  )
}

function CreatorCard({ creator, onOpen }: { creator: Creator; onOpen: () => void }): React.JSX.Element {
  const avatar = useAvatar(creator.id)
  const platforms = CREATOR_PLATFORMS.filter((platform) => creator.links[platform])
  return (
    <button
      onClick={onOpen}
      className="glass flex w-full items-center gap-3 rounded-2xl p-3 text-left transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-0.5"
    >
      <Avatar src={avatar} name={creator.name} className="h-12 w-12 text-lg" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-ink">{creator.name}</span>
          {creator.notify && <Bell aria-label="Notifications on" className="h-3 w-3 shrink-0 text-ink-subtle" />}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {platforms.map((platform) => <CreatorIcon key={platform} platform={platform} />)}
        </span>
      </span>
    </button>
  )
}

function CreatorProfile({ creator, onBack, onEdit, onChanged, onDeleted, onNavigate }: {
  creator: Creator
  onBack: () => void
  onEdit: () => void
  onChanged: () => void
  onDeleted: () => void
  onNavigate: (page: AppPage) => void
}): React.JSX.Element {
  const platforms = useMemo(() => FEED_PLATFORMS.filter((platform) => creator.links[platform]), [creator.links])
  const [platform, setPlatform] = useState<FeedPlatform | null>(platforms[0] ?? null)
  const [youtubeKind, setYoutubeKind] = useState<YoutubeKind>('lives')
  const [feed, setFeed] = useState<CreatorFeed | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const avatar = useAvatar(creator.id)
  const closeConfirm = useCallback(() => setConfirm(null), [])

  useEffect(() => {
    if (platform && !platforms.includes(platform)) setPlatform(platforms[0] ?? null)
  }, [platform, platforms])

  const loadFeed = useCallback(async (refresh = false) => {
    if (!platform) return
    setLoading(true)
    try {
      const result = await getApi().creators.feed(creator.id, platform, refresh, youtubeKind)
      setFeed(result)
      // What's listed now has been seen: later uploads will show as new.
      if (!result.error) void getApi().creators.markViewed(creator.id, platform)
    } catch (err) {
      setError(errorMessage(err, 'Could not load these videos.'))
    } finally {
      setLoading(false)
    }
  }, [creator.id, platform, youtubeKind])

  useEffect(() => {
    setFeed(null)
    void loadFeed()
  }, [loadFeed])

  const toggleNotify = async (): Promise<void> => {
    try {
      await getApi().creators.setNotify(creator.id, !creator.notify)
      onChanged()
    } catch (err) {
      setError(errorMessage(err, 'Could not change notifications.'))
    }
  }

  const remove = (): void => setConfirm({
    title: 'Remove this creator?',
    body: `“${creator.name}” will be removed from Creators. Nothing on their channels changes.`,
    confirmLabel: 'Remove',
    onConfirm: () => { void getApi().creators.delete(creator.id).then(onDeleted).catch((err) => setError(errorMessage(err, 'Could not remove this creator.'))) }
  })

  const clip = (item: FeedItem): void => {
    const draft = useDraftStore.getState()
    draft.startAnother()
    draft.update({ source: item.url })
    onNavigate('clip')
  }

  const links = CREATOR_PLATFORMS.filter((p) => creator.links[p])

  return (
    <Page width="wide">
      <PageHeader
        leading={<BackLink label="Creators" onClick={onBack} />}
        title={
          <span className="flex items-center gap-3">
            <Avatar src={feed?.avatar ?? avatar} name={creator.name} className="h-10 w-10 text-base" />
            <span className="truncate">{creator.name}</span>
          </span>
        }
        actions={
          <>
            <Button variant="ghost" icon={creator.notify ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />} onClick={() => { void toggleNotify() }} aria-pressed={creator.notify}>
              {creator.notify ? 'Notifications on' : 'Notifications off'}
            </Button>
            <Button variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit}>Edit</Button>
            <Button variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>Remove</Button>
          </>
        }
      />

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Profiles">
        {links.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => { void getApi().creators.openProfile(creator.id, p) }}
            title={creator.links[p]}
            className="glass-chip inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-ink hover:bg-white/20"
          >
            <CreatorIcon platform={p} />
            {creatorAccount(creator.links[p] as string)}
            <ExternalLink className="h-3 w-3 text-ink-subtle" />
          </button>
        ))}
      </div>

      {error && <Callout tone="danger" className="mt-4" onDismiss={() => setError(null)}>{error}</Callout>}

      {platform ? (
        <>
          <div className="mt-5 flex items-center justify-between gap-3">
            <Segmented
              label="Platform"
              value={platform}
              onChange={setPlatform}
              options={platforms.map((p) => ({ value: p, label: <span className="inline-flex items-center gap-1.5"><CreatorIcon platform={p} />{CREATOR_PLATFORM_NAMES[p]}</span> }))}
            />
            <span className="flex items-center gap-2">
              {platform === 'youtube' && (
                <Segmented
                  label="YouTube list"
                  size="sm"
                  value={youtubeKind}
                  onChange={setYoutubeKind}
                  options={[{ value: 'lives', label: 'Lives' }, { value: 'uploads', label: 'Videos' }]}
                />
              )}
              <Button variant="ghost" iconOnly aria-label="Refresh" title="Refresh" icon={<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />} onClick={() => { void loadFeed(true) }} disabled={loading} />
            </span>
          </div>

          {feed?.error && <Callout tone="warning" className="mt-4">{feed.error}</Callout>}

          {feed?.live && (
            <button
              type="button"
              onClick={() => { void getApi().creators.openVideo(feed.live!.url) }}
              className="mt-4 flex w-full items-center gap-3 rounded-2xl bg-danger/[0.12] px-4 py-3 text-left shadow-[inset_0_0_0_1px_rgb(var(--danger)/0.3)]"
            >
              <Radio className="h-4 w-4 shrink-0 text-danger" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">Live now on {CREATOR_PLATFORM_NAMES[platform]}{feed.live.viewers != null ? ` · ${feed.live.viewers.toLocaleString()} watching` : ''}</span>
                <span className="block truncate text-xs text-ink-muted">{feed.live.title}</span>
              </span>
              <ExternalLink className="h-3.5 w-3.5 text-ink-subtle" />
            </button>
          )}

          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {feed === null
              ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="aspect-video rounded-2xl" />)
              : feed.items.map((item) => <VideoCard key={item.id} item={item} onClip={() => clip(item)} />)}
          </div>
          {feed && !feed.error && feed.items.length === 0 && (
            <p className="mt-4 text-sm text-ink-subtle">{platform === 'youtube' && youtubeKind === 'lives' ? 'No streams on their YouTube Live tab. Switch to Videos to see uploads.' : `No videos on ${CREATOR_PLATFORM_NAMES[platform]} yet.`}</p>
          )}
        </>
      ) : (
        <p className="mt-6 text-sm text-ink-subtle">Add a YouTube, Twitch or Kick channel to see their videos here.</p>
      )}
      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
    </Page>
  )
}

function VideoCard({ item, onClip }: { item: FeedItem; onClip: () => void }): React.JSX.Element {
  const meta = [item.publishedAt ? formatRelativeDate(item.publishedAt) : null, views(item.views)].filter(Boolean).join(' · ')
  return (
    <article className="glass flex flex-col rounded-2xl p-1.5">
      <button
        type="button"
        onClick={() => { void getApi().creators.openVideo(item.url) }}
        aria-label={`Open “${item.title}”`}
        className="relative aspect-video overflow-hidden rounded-xl bg-black/40"
      >
        {item.thumbnail ? <img src={item.thumbnail} alt="" className="h-full w-full object-cover" /> : <Skeleton className="h-full rounded-none" />}
        {item.isNew && <Badge tone="accent" className="absolute left-2 top-2">New</Badge>}
        {item.durationSeconds != null && (
          <span className="glass-chip absolute bottom-2 right-2 rounded-full px-1.5 py-px font-mono text-2xs tabular text-white">{formatTimecode(item.durationSeconds * 1000)}</span>
        )}
      </button>
      <div className="flex flex-1 flex-col px-1.5 pb-1 pt-2">
        <h3 className="line-clamp-2 text-sm font-medium leading-[18px] text-ink" title={item.title}>{item.title}</h3>
        {meta && <p className="mt-1 truncate text-2xs text-ink-subtle">{meta}</p>}
        <div className="mt-2 flex gap-1.5">
          <Button size="sm" variant="primary" icon={<Scissors className="h-3.5 w-3.5" />} onClick={onClip}>Clip this</Button>
          <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => { void getApi().creators.openVideo(item.url) }}>Open</Button>
        </div>
      </div>
    </article>
  )
}

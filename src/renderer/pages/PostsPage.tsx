import { useMemo, useState } from 'react'
import { Clapperboard, RefreshCw, Send } from 'lucide-react'
import { cn } from '../lib/utils'
import { usePostsStore, usePostsSync } from '../store/use-posts-store'
import { useSettingsStore } from '../store/use-settings-store'
import type { PostRecord } from '../../shared/zernio-posts'
import { PostRow } from '../components/PostRow'
import { Page as PageColumn } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { EmptyState } from '../components/ui/EmptyState'
import type { Page } from '../components/Sidebar'

const TITLE = 'Posts'
const RECENT_LIMIT = 10


export function PostsPage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const configured = useSettingsStore((s) => s.zernioConfigured)
  return (
    <PageColumn width="narrow">
      {configured ? (
        <PostsList onNavigate={onNavigate} />
      ) : (
        <>
          <PageHeader title={TITLE} />
          <EmptyState
            className="mt-4"
            icon={<Send />}
            title="Connect your social accounts"
            description="Clips you post or schedule from SparkClip show up here once Zernio is set up in Accounts."
            action={<Button variant="primary" onClick={() => onNavigate('accounts')}>Open Accounts</Button>}
          />
        </>
      )}
    </PageColumn>
  )
}

/** Posts made from SparkClip: scheduled, failed and recent, with cancel, retry and links. */
function PostsList({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const { posts, loaded, refreshing, error, clearError, refresh } = usePostsStore()
  const [showAll, setShowAll] = useState(false)

  usePostsSync()

  const groups = useMemo(() => {
    const scheduled = posts.filter((p) => p.status === 'scheduled').sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''))
    const attention = posts.filter((p) => p.status === 'failed' || p.status === 'partial' || p.status === 'missing')
    const recent = posts.filter((p) => !scheduled.includes(p) && !attention.includes(p))
    return { scheduled, attention, recent }
  }, [posts])
  const recent = showAll ? groups.recent : groups.recent.slice(0, RECENT_LIMIT)

  return (
    <>
      <PageHeader
        title={TITLE}
        className="items-center"
        actions={
          <Button
            variant="ghost"
            iconOnly
            aria-label="Refresh posts"
            title="Refresh"
            onClick={() => void refresh(true)}
            disabled={refreshing}
            icon={<RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />}
          />
        }
      />

      <div className="mt-4 space-y-3">
        {error && (
          <Callout tone="danger" onDismiss={clearError}>
            {error}
          </Callout>
        )}

        {!loaded ? (
          <Panel padded={false}>
            <p role="status" className="px-4 py-3 text-xs text-ink-muted">Loading your posts…</p>
          </Panel>
        ) : posts.length === 0 && error ? (
          <Panel padded={false} className="flex items-center justify-between gap-3 py-2 pl-4 pr-2.5">
            <p className="text-xs text-ink-muted">Your post history is unavailable right now.</p>
            <Button size="sm" onClick={() => void usePostsStore.getState().load()}>Try again</Button>
          </Panel>
        ) : posts.length === 0 ? (
          <EmptyState
            icon={<Send />}
            title="Nothing posted yet"
            description="Open a run in the Library and choose Post on a clip. Scheduled posts wait here until they go out."
            action={
              <Button icon={<Clapperboard className="h-3.5 w-3.5" />} onClick={() => onNavigate('library')}>
                Open Library
              </Button>
            }
          />
        ) : (
          <Panel padded={false} className="overflow-hidden">
            <PostGroup title="Scheduled" posts={groups.scheduled} />
            <PostGroup title="Needs attention" posts={groups.attention} />
            <PostGroup title="Recent" posts={recent} />
            {groups.recent.length > RECENT_LIMIT && (
              <div className="border-t border-white/[0.06] px-2.5 py-1.5">
                <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show all ${groups.recent.length}`}
                </Button>
              </div>
            )}
          </Panel>
        )}

        <p className="px-1 text-2xs text-ink-subtle">Zernio publishes scheduled posts even when SparkClip is closed.</p>
      </div>
    </>
  )
}

function PostGroup({ title, posts }: { title: string; posts: PostRecord[] }): React.JSX.Element | null {
  if (posts.length === 0) return null
  return (
    <section className="border-t border-white/[0.06] first:border-t-0" aria-label={title}>
      <h2 className="eyebrow flex items-center gap-2 px-4 pb-0.5 pt-2">
        {title}
        <span className="rounded-full bg-white/[0.07] px-1.5 py-px font-mono text-[10px] tabular tracking-normal text-ink-muted">{posts.length}</span>
      </h2>
      <ul className="divide-y divide-white/[0.05]">
        {posts.map((post) => <PostRow key={post.id} post={post} />)}
      </ul>
    </section>
  )
}


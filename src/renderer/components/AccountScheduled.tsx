import { CalendarClock, Clapperboard, RefreshCw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '../lib/utils'
import { usePostsStore } from '../store/use-posts-store'
import { scheduledPostsFor } from '../../shared/zernio-posts'
import type { ZernioAccount } from '../../shared/zernio'
import { PostRow } from './PostRow'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { EmptyState } from './ui/EmptyState'
import { Panel } from './ui/Panel'

/**
 * The posts scheduled from SparkClip that will go out to this account. Each
 * keeps Reschedule and Cancel; a post made for several accounts shows them all.
 * The caller keeps the post history in sync (usePostsSync).
 */
export function AccountScheduled({ account, onOpenLibrary }: { account: ZernioAccount; onOpenLibrary: () => void }): React.JSX.Element {
  const posts = usePostsStore(useShallow((state) => scheduledPostsFor(state.posts, account.id)))
  const { loaded, refreshing, error, refresh, clearError } = usePostsStore()

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-xs text-ink-muted">
          <span className="font-mono tabular text-ink">{posts.length}</span> scheduled · Zernio publishes them even when SparkClip is closed
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />}
          onClick={() => void refresh(true)}
          disabled={refreshing}
          aria-label="Refresh scheduled posts"
        >
          Refresh
        </Button>
      </div>

      {error && <Callout tone="danger" onDismiss={clearError}>{error}</Callout>}

      {!loaded ? (
        <Panel padded={false}>
          <p role="status" className="px-4 py-3 text-xs text-ink-muted">Loading your scheduled posts…</p>
        </Panel>
      ) : posts.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="Nothing scheduled"
          description="In the Library, choose Post on a clip, pick this account and choose Schedule. It waits here until it goes out."
          action={<Button icon={<Clapperboard className="h-3.5 w-3.5" />} onClick={onOpenLibrary}>Open Library</Button>}
        />
      ) : (
        <Panel padded={false} className="overflow-hidden">
          <ul aria-label="Scheduled posts" className="divide-y divide-white/[0.05]">
            {posts.map((post) => <PostRow key={post.id} post={post} />)}
          </ul>
        </Panel>
      )}
    </div>
  )
}

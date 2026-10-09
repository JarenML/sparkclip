import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { localFileUrl } from '../lib/utils'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'

/** Plays a clip from disk, e.g. the one a scheduled post will publish. Escape or the backdrop closes it. */
export function ClipPlayerDialog({ path, title, onClose }: { path: string; title: string; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [missing, setMissing] = useState(false)
  // The latest onClose, so a parent re-render doesn't move focus around.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    // Focus returns to whatever opened the player.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      opener?.focus()
    }
  }, [])

  return (
    <Dialog aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[min(92vw,720px)] w-auto">
      <div className="flex items-center gap-3 px-4 pb-2 pt-3">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={title}>{title || 'Untitled clip'}</h2>
        <Button ref={closeRef} variant="ghost" size="sm" iconOnly aria-label="Close player" onClick={onClose} icon={<X className="h-4 w-4" />} />
      </div>
      <div className="flex justify-center bg-black px-4 pb-4">
        {missing ? (
          <p role="alert" className="py-16 text-sm text-ink-muted">This clip is no longer on disk, so it can’t play here.</p>
        ) : (
          <video
            src={localFileUrl(path)}
            controls
            autoPlay
            playsInline
            onError={() => setMissing(true)}
            aria-label={`Clip: ${title}`}
            className="max-h-[72vh] max-w-full rounded-xl bg-black"
          />
        )}
      </div>
    </Dialog>
  )
}

import { useEffect, useId, useRef, useState } from 'react'
import type { Creator } from '../../shared/creators'
import type { HistoryEntry } from '../../preload/index'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Select } from './ui/Select'

/**
 * Assigns a finished run's clips to a followed creator (or to none), so they
 * show on that creator's Clips tab. Escape and the backdrop cancel. Pass a stable `onClose`.
 */
export function AssignCreatorDialog({ entry, creators, onClose, onSaved }: {
  entry: HistoryEntry
  creators: Creator[]
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [creatorId, setCreatorId] = useState(entry.creatorId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [onClose])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await getApi().history.setCreator(entry.jobId, creatorId || null)
      onSaved()
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Could not assign this run.'))
      setSaving(false)
    }
  }

  // A creator removed from Creators still shows as the current choice until changed.
  const known = !entry.creatorId || creators.some((creator) => creator.id === entry.creatorId)
  const options = [
    { value: '', label: 'No creator' },
    ...creators.map(({ id, name }) => ({ value: id, label: name })),
    ...(known ? [] : [{ value: entry.creatorId as string, label: 'Removed creator', disabled: true }])
  ]

  return (
    <Dialog ref={panelRef} aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[420px]">
      <div className="space-y-3 px-5 pb-5 pt-5">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-ink">Assign to creator</h2>
          <p className="mt-1.5 truncate text-sm text-ink-muted" title={entry.videoTitle}>{entry.videoTitle}</p>
        </div>
        {creators.length === 0 && !entry.creatorId ? (
          <p className="text-sm text-ink-subtle">Follow a creator in Creators first, then assign runs to them here.</p>
        ) : (
          <Select aria-label="Creator" value={creatorId} options={options} onChange={setCreatorId} disabled={saving} />
        )}
        <p className="text-2xs text-ink-subtle">The clips show on that creator's Clips tab. They stay in Library either way.</p>
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => { void save() }} loading={saving} disabled={creatorId === (entry.creatorId ?? '')}>
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

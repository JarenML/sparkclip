import { useEffect, useId, useRef, useState } from 'react'
import { CREATOR_PLATFORMS, CREATOR_PLATFORM_NAMES, FEED_PLATFORMS, creatorLink, type Creator, type CreatorPlatform } from '../../shared/creators'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { CreatorIcon } from './CreatorIcon'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'
import { TextInput } from './ui/Field'
import { Switch } from './ui/Switch'

const PLACEHOLDERS: Record<CreatorPlatform, string> = {
  youtube: 'youtube.com/@channel or @channel',
  twitch: 'twitch.tv/name or name',
  kick: 'kick.com/name or name',
  tiktok: 'tiktok.com/@name or @name',
  instagram: 'instagram.com/name or @name',
  x: 'x.com/name or @name'
}

/** Adds a creator, or edits one when `creator` is given. */
export function CreatorDialog({ creator, onSaved, onClose }: {
  creator?: Creator
  onSaved: (creator: Creator) => void
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(creator?.name ?? '')
  const [links, setLinks] = useState<Partial<Record<CreatorPlatform, string>>>(creator?.links ?? {})
  const [notify, setNotify] = useState(creator?.notify ?? true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    nameRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const invalid = CREATOR_PLATFORMS.filter((platform) => (links[platform] ?? '').trim() && !creatorLink(platform, links[platform] ?? ''))
  const hasLink = CREATOR_PLATFORMS.some((platform) => (links[platform] ?? '').trim())
  const canSave = !!name.trim() && hasLink && invalid.length === 0 && !saving

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      onSaved(await getApi().creators.save({ name, links, notify }, creator?.id))
    } catch (err) {
      setError(errorMessage(err, 'Could not save this creator.'))
      setSaving(false)
    }
  }

  return (
    <Dialog aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[480px]">
      <form className="min-h-0 overflow-y-auto px-5 pb-5 pt-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <h2 id={titleId} className="text-base font-semibold text-ink">{creator ? 'Edit creator' : 'Add a creator'}</h2>
        <p className="mt-1 text-sm text-ink-muted">YouTube, Twitch and Kick show their latest videos here. The others open in your browser.</p>
        <label className="mt-4 block text-xs text-ink-subtle" htmlFor={`${titleId}-name`}>Name</label>
        <TextInput id={`${titleId}-name`} ref={nameRef} className="mt-1" value={name} maxLength={80} placeholder="IShowSpeed" onChange={(e) => setName(e.target.value)} />
        <div className="mt-4 space-y-2">
          {CREATOR_PLATFORMS.map((platform) => {
            const bad = invalid.includes(platform)
            return (
              <div key={platform}>
                <TextInput
                  aria-label={`${CREATOR_PLATFORM_NAMES[platform]} profile`}
                  aria-invalid={bad}
                  leading={<CreatorIcon platform={platform} className="h-4 w-4" />}
                  value={links[platform] ?? ''}
                  placeholder={PLACEHOLDERS[platform]}
                  onChange={(e) => setLinks((current) => ({ ...current, [platform]: e.target.value }))}
                  spellCheck={false}
                />
                {bad && <p className="mt-1 text-2xs text-danger">That doesn’t look like a {CREATOR_PLATFORM_NAMES[platform]} profile link.</p>}
              </div>
            )
          })}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-black/20 px-3 py-2">
          <div>
            <p className="text-sm text-ink">Notify me</p>
            <p className="text-2xs text-ink-subtle">When they post on {FEED_PLATFORMS.map((p) => CREATOR_PLATFORM_NAMES[p]).join(', ')} or go live. Checked every 15 minutes while SparkClip is open.</p>
          </div>
          <Switch label="Notify me" checked={notify} onChange={setNotify} />
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-danger" data-selectable>{error}</p>}
        <button type="submit" hidden />
      </form>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => { void submit() }} disabled={!canSave} loading={saving}>{creator ? 'Save' : 'Add creator'}</Button>
      </DialogFooter>
    </Dialog>
  )
}

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Copy, Smartphone } from 'lucide-react'
import { renderSVG } from 'uqr'
import type { LanShare } from '../../shared/lan-share'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Skeleton } from './ui/Skeleton'

/** A QR code for a link, as an SVG image data URL. */
export function qrDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(text, { ecc: 'M', border: 2 }))}`
}

/**
 * Shares a run's clips with phones on the same network and shows the link as
 * a QR code. Closing keeps sharing; "Stop sharing" ends it.
 */
export function ShareDialog({ outputDir, onClose }: { outputDir: string; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const doneRef = useRef<HTMLButtonElement>(null)
  const [share, setShare] = useState<LanShare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    getApi().share.start(outputDir)
      .then((result) => { if (!cancelled) setShare(result) })
      .catch((err) => { if (!cancelled) setError(errorMessage(err, 'Could not share these clips.')) })
    return () => { cancelled = true }
  }, [outputDir])

  useEffect(() => {
    doneRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const link = share?.urls[0] ?? null
  const qr = useMemo(() => (link ? qrDataUrl(link) : null), [link])
  const until = share ? new Date(share.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null

  const stop = (): void => {
    void getApi().share.stop().finally(onClose)
  }
  const copy = (): void => {
    if (!link) return
    void getApi().clipboard.writeText(link).then(setCopied).catch(() => setCopied(false))
  }

  return (
    <Dialog aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[420px]">
      <div className="px-5 pb-5 pt-5">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-ink">
          <Smartphone className="h-4 w-4" /> Watch on your phone
        </h2>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger" data-selectable>{error}</p>
        ) : (
          <>
            <p className="mt-1.5 text-sm text-ink-muted">
              Scan with your phone’s camera. The phone must be on the same Wi-Fi as this computer.
            </p>
            <div className="mt-4 flex justify-center">
              {qr ? (
                <img src={qr} alt={`QR code for ${link}`} className="h-56 w-56 rounded-xl bg-white p-1" />
              ) : (
                <Skeleton className="h-56 w-56 rounded-xl" />
              )}
            </div>
            {link && (
              <div className="mt-3 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-black/30 px-2 py-1.5 font-mono text-2xs text-ink" title={link} data-selectable>{link}</code>
                <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
              </div>
            )}
            {share && share.urls.length > 1 && (
              <p className="mt-2 text-2xs text-ink-subtle" data-selectable>
                If it doesn’t open, try: {share.urls.slice(1).join(' · ')}
              </p>
            )}
            <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">
              Anyone on this network with the link can watch these clips{until ? `, until ${until}` : ''} or until you stop sharing or quit SparkClip. If Windows asks, allow SparkClip on private networks only. Avoid sharing on public Wi-Fi.
            </p>
          </>
        )}
      </div>
      <DialogFooter>
        {share && <Button variant="danger" onClick={stop}>Stop sharing</Button>}
        <Button ref={doneRef} onClick={onClose}>{share ? 'Done' : 'Close'}</Button>
      </DialogFooter>
    </Dialog>
  )
}

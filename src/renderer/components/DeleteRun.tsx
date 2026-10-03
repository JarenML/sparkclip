import { useCallback, useState } from 'react'
import { getApi } from '../lib/ipc'
import { errorMessage, formatBytes } from '../lib/utils'
import { ConfirmDialog, type ConfirmRequest } from './ui/ConfirmDialog'

export interface DeletableRun {
  jobId: string
  title: string
  clipCount: number
}

/**
 * Confirms and deletes a finished run: its folder in the output directory and
 * everything cached for it. `onDeleted` gets a message saying how much space
 * was freed; `onError` gets a message to show if deleting failed.
 */
export function useDeleteRun(onDeleted: (message: string) => void, onError: (message: string) => void): {
  ask: (run: DeletableRun) => void
  dialog: React.JSX.Element | null
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const close = useCallback(() => setRequest(null), [])

  const ask = useCallback((run: DeletableRun) => {
    const clips = run.clipCount > 0 ? `its ${run.clipCount} clip${run.clipCount === 1 ? '' : 's'}, transcript and results` : 'its files'
    setRequest({
      title: 'Delete this job?',
      body: `“${run.title}” and ${clips} will be permanently removed from your output folder. Clips you added to an automation keep their own copy. This can’t be undone.`,
      confirmLabel: 'Delete job',
      onConfirm: () => {
        getApi().history.delete(run.jobId)
          .then(({ freedBytes }) => onDeleted(`Deleted “${run.title}” and freed ${formatBytes(freedBytes)}.`))
          .catch((err) => onError(errorMessage(err, 'Could not delete this job.')))
      }
    })
  }, [onDeleted, onError])

  return { ask, dialog: request ? <ConfirmDialog request={request} onClose={close} /> : null }
}

import { useEffect, useState } from 'react'
import { getApi } from '../lib/ipc'
import { cn } from '../lib/utils'
import type { ZernioAccount } from '../../shared/zernio'
import { PlatformIcon } from './PlatformIcon'

// Per account and picture link, for this session: each picture is fetched once.
const pictures = new Map<string, Promise<string | null>>()

function picture(accountId: string, pictureUrl: string | null): Promise<string | null> {
  const key = `${accountId}:${pictureUrl ?? ''}`
  let request = pictures.get(key)
  if (!request) {
    request = pictureUrl ? getApi().zernio.accountPicture(accountId).catch(() => null) : Promise.resolve(null)
    pictures.set(key, request)
  }
  return request
}

export type AvatarStatus = 'ok' | 'warning' | 'connecting'

/**
 * The account's profile picture with its platform's badge and a status dot;
 * the platform's icon until the picture loads, or when there is none.
 */
export function AccountAvatar({ account, status, size = 'md' }: { account: ZernioAccount; status: AvatarStatus; size?: 'md' | 'lg' }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const pictureUrl = account.pictureUrl ?? null
  useEffect(() => {
    let current = true
    void picture(account.id, pictureUrl).then((data) => { if (current) setSrc(data) })
    return () => { current = false }
  }, [account.id, pictureUrl])

  const box = size === 'lg' ? 'h-10 w-10' : 'h-8 w-8'
  return (
    <span className="relative shrink-0" data-avatar={src ? 'picture' : 'platform'}>
      {src ? (
        <img src={src} alt="" draggable={false} className={cn(box, 'rounded-full object-cover ring-1 ring-white/[0.12]')} />
      ) : (
        <PlatformIcon platform={account.platform} className={cn(box, 'rounded-lg')} />
      )}
      {src && (
        <PlatformIcon
          platform={account.platform}
          className="absolute -bottom-0.5 -left-0.5 h-4 w-4 rounded-full ring-2 ring-canvas [&_svg]:h-2.5 [&_svg]:w-2.5"
        />
      )}
      <span
        aria-hidden
        className={cn(
          'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-canvas',
          status === 'ok' ? 'bg-success' : status === 'warning' ? 'bg-warning' : 'animate-pulse bg-accent'
        )}
      />
    </span>
  )
}

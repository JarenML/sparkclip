import lockupUrl from '../../../../resources/sparkclip-logo.svg'
import iconUrl from '../../../../resources/sparkclip-icon.svg'
import markUrl from '../../../../resources/sparkclip-mark.svg'
import { cn } from '../../lib/utils'

interface BridgeClipLogoProps {
  /**
   * lockup: SparkClip mark + "SparkClip" wordmark (artwork is for dark surfaces).
   * icon:   the app icon tile, a blue play emblem with a spark cut out of it.
   * mark:   the mark alone, for tight spaces such as the collapsed sidebar.
   */
  variant?: 'lockup' | 'icon' | 'mark'
  /** Size by height (e.g. "h-6"); width follows the artwork. */
  className?: string
  alt?: string
}

/**
 * SparkClip brand artwork. Regenerate the exports with
 * scripts/icon/build-logo.py (lockup) and `npm run icons` (app icons).
 */
export function BridgeClipLogo({ variant = 'lockup', className, alt = 'SparkClip' }: BridgeClipLogoProps): React.JSX.Element {
  return (
    <img
      src={variant === 'icon' ? iconUrl : variant === 'mark' ? markUrl : lockupUrl}
      alt={alt}
      draggable={false}
      className={cn('w-auto shrink-0 select-none', className)}
    />
  )
}

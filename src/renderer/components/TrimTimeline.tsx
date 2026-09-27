import { useRef, useState } from 'react'
import { cn, formatTimecode } from '../lib/utils'

type Handle = 'start' | 'end'

interface TrimTimelineProps {
  /** Source length in seconds. */
  duration: number
  /** Selected range in seconds; null is an open bound (start of video / end of video). */
  start: number | null
  end: number | null
  onChange: (start: number | null, end: number | null) => void
  disabled?: boolean
}

/** The shortest range the handles allow, in seconds. */
const MIN_RANGE = 1

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function label(seconds: number): string {
  return formatTimecode(seconds * 1000)
}

/**
 * Drag two handles to choose the part of the source to clip. The handles
 * report whole seconds; a handle at either edge means an open bound, so the
 * typed start/end fields stay empty in that case.
 */
export function TrimTimeline({ duration, start, end, onChange, disabled }: TrimTimelineProps): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<Handle | null>(null)
  const total = Math.max(MIN_RANGE, Math.floor(duration))
  const from = clamp(Math.round(start ?? 0), 0, total - MIN_RANGE)
  const to = clamp(Math.round(end ?? total), from + MIN_RANGE, total)

  const emit = (nextFrom: number, nextTo: number): void => {
    onChange(nextFrom <= 0 ? null : nextFrom, nextTo >= total ? null : nextTo)
  }

  const move = (handle: Handle, value: number): void => {
    const rounded = Math.round(value)
    if (handle === 'start') emit(clamp(rounded, 0, to - MIN_RANGE), to)
    else emit(from, clamp(rounded, from + MIN_RANGE, total))
  }

  const valueAt = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return clamp((clientX - rect.left) / rect.width, 0, 1) * total
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return
    const value = valueAt(e.clientX)
    // Grab the handle the pointer is on, else the nearer one.
    const target = (e.target as HTMLElement).dataset.handle as Handle | undefined
    const handle = target ?? (Math.abs(value - from) <= Math.abs(value - to) ? 'start' : 'end')
    setDragging(handle)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (!target) move(handle, value)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragging) move(dragging, valueAt(e.clientX))
  }

  const stopDragging = (): void => setDragging(null)

  const onKeyDown = (handle: Handle) => (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const current = handle === 'start' ? from : to
    const step = e.shiftKey ? 10 : 1
    const next = {
      ArrowLeft: current - step,
      ArrowDown: current - step,
      ArrowRight: current + step,
      ArrowUp: current + step,
      PageDown: current - 60,
      PageUp: current + 60,
      Home: 0,
      End: total
    }[e.key]
    if (next === undefined) return
    e.preventDefault()
    move(handle, next)
  }

  const pct = (value: number): string => `${(value / total) * 100}%`

  const handleProps = (handle: Handle, value: number, min: number, max: number): React.HTMLAttributes<HTMLDivElement> & { 'data-handle': Handle } => ({
    role: 'slider',
    tabIndex: disabled ? -1 : 0,
    'aria-label': handle === 'start' ? 'Trim start' : 'Trim end',
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': value,
    'aria-valuetext': label(value),
    'aria-disabled': disabled || undefined,
    'data-handle': handle,
    onKeyDown: onKeyDown(handle),
    style: { left: pct(value) },
    className: cn(
      'absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white',
      'shadow-[0_1px_3px_rgb(0_0_0/0.45),0_0_0_2px_rgb(var(--accent))] outline-none transition-transform duration-150',
      'focus-visible:scale-110 focus-visible:shadow-[0_1px_3px_rgb(0_0_0/0.45),0_0_0_2px_rgb(var(--accent)),0_0_0_5px_rgb(var(--accent)/0.3)]',
      dragging === handle && 'scale-110',
      disabled ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
    )
  })

  return (
    <div className={cn('select-none', disabled && 'opacity-40')}>
      <div
        ref={track}
        className={cn('relative flex h-8 items-center touch-none', !disabled && 'cursor-pointer')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        <div className="relative h-2 w-full rounded-full bg-black/35 shadow-[inset_0_1px_1px_rgb(0_0_0/0.4),0_1px_0_rgb(255_255_255/0.04)]">
          <div className="absolute inset-y-0 rounded-full bg-accent" style={{ left: pct(from), width: pct(to - from) }} />
        </div>
        <div {...handleProps('start', from, 0, to - MIN_RANGE)} />
        <div {...handleProps('end', to, from + MIN_RANGE, total)} />
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-2xs tabular text-ink-subtle">
        <span>{label(from)}</span>
        <span className="text-ink">{label(to - from)} selected</span>
        <span>{label(to)}</span>
      </div>
    </div>
  )
}

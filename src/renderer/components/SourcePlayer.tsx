import { useEffect, useRef, useState } from 'react'
import type { SourceStream } from '../../shared/video-source'
import { localFileUrl } from '../lib/utils'

/** A request to jump the player to a time; `key` makes repeated jumps to the same time count. */
export interface SeekRequest {
  time: number
  key: number
}

interface SourcePlayerProps {
  /** A local file path, used when there is no stream. */
  source: string
  stream: SourceStream | null
  seek?: SeekRequest | null
}

const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com'

/**
 * Plays the chosen source in the Create form: local files from disk, Kick
 * VODs as HLS through the main process's stream proxy, YouTube through its
 * embed player. Seek requests (from the trim timeline) jump to that time.
 */
export function SourcePlayer({ source, stream, seek }: SourcePlayerProps): React.JSX.Element {
  if (stream?.kind === 'youtube') return <YouTubePlayer id={stream.id} seek={seek} />
  return <VideoPlayer src={stream?.kind === 'hls' ? stream.url : localFileUrl(source)} hls={stream?.kind === 'hls'} seek={seek} />
}

function VideoPlayer({ src, hls, seek }: { src: string; hls: boolean; seek?: SeekRequest | null }): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const element = video.current
    if (!element) return
    setFailed(false)
    if (!hls) {
      element.src = src
      return
    }
    let active = true
    let player: { destroy: () => void } | null = null
    // Loaded on demand: most runs never open the preview.
    void import('hls.js').then(({ default: Hls }) => {
      if (!active) return
      if (!Hls.isSupported()) {
        setFailed(true)
        return
      }
      const instance = new Hls({
        enableWorker: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        // The preview needs no captions or metadata cues; hls.js would add them
        // as data: text tracks, which the renderer CSP blocks.
        enableWebVTT: false,
        enableIMSC1: false,
        enableCEA708Captions: false,
        enableID3MetadataCues: false,
        enableEmsgMetadataCues: false,
        enableDateRangeMetadataCues: false,
        renderTextTracksNatively: false
      })
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setFailed(true)
      })
      instance.loadSource(src)
      instance.attachMedia(element)
      player = instance
    }).catch(() => setFailed(true))
    return () => {
      active = false
      player?.destroy()
    }
  }, [src, hls])

  useEffect(() => {
    const element = video.current
    if (element && seek && Number.isFinite(seek.time)) element.currentTime = Math.max(0, seek.time)
  }, [seek])

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
      <video ref={video} controls playsInline preload="metadata" className="h-full w-full" onError={() => setFailed(true)} />
      {failed && (
        <p role="alert" className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-ink-subtle">
          The preview could not be loaded. You can still clip this video.
        </p>
      )}
    </div>
  )
}

function YouTubePlayer({ id, seek }: { id: string; seek?: SeekRequest | null }): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const target = frame.current?.contentWindow
    if (!target || !seek || !Number.isFinite(seek.time)) return
    // The embed's postMessage API (enablejsapi=1); no player script needed.
    target.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [Math.max(0, seek.time), true] }), YOUTUBE_ORIGIN)
  }, [seek])

  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
      <iframe
        ref={frame}
        title="YouTube preview"
        src={`${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(id)}?enablejsapi=1&rel=0&playsinline=1`}
        className="h-full w-full"
        allow="encrypted-media; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation"
      />
    </div>
  )
}

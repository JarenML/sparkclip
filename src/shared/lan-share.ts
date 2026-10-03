/** A run's clips served to phones on the local network (see src/main/lan-share.ts). */
export interface LanShare {
  outputDir: string
  /** One link per local network address; any of them opens the clip page. */
  urls: string[]
  /** When the share stops on its own. */
  expiresAt: string
}

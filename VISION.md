# SparkClip Vision

## What it is

SparkClip is a customized and improved rebrand of [BridgeClip](https://github.com/bridge-mind/bridgeclip), the open-source (MIT-licensed) platform created by [BridgeMind](https://www.bridgemind.ai). SparkClip is an independent project: it is not affiliated with or endorsed by BridgeMind, and it keeps the original license notice.

BridgeClip already solves the hard part: it takes a long video, transcribes it, uses AI to find the best moments and renders captioned vertical clips, all on the user's own computer. SparkClip builds on that and points it at a specific use.

## Goal

Build an in-house tool for **running a streamer clipping business**: turn streams and VODs into short clips, publish them across multiple accounts and platforms, and earn revenue from that content.

Specifically, SparkClip should make it possible to:

1. **Clip streamer content.** Pull VODs from Twitch, Kick, YouTube or other sources, detect the moments with the most potential and produce ready-to-post clips (9:16, captions, smart framing, speed).
2. **Manage multiple accounts.** Connect and organize TikTok, Facebook, YouTube and other social accounts from one place.
3. **Publish and schedule.** Upload or schedule clips to those accounts, with titles, descriptions and hashtags tailored to each platform.
4. **Scale to new platforms.** Design sources (where videos come from) and destinations (where they are published) so that adding a new platform is straightforward.
5. **Make money.** Everything above exists to produce monetizable content consistently and with little manual work.

## What changes from BridgeClip

- **Own brand:** SparkClip name, logo, icons and visual identity.
- **Streamer focus:** Twitch and Kick VOD support, a source video preview with a trim timeline, and a per-clip score breakdown to choose what to post.
- **Ongoing improvements** to moment selection, framing, captions and the publishing flow, based on what works in practice.

## Principles

- **Local first.** Processing runs on your own machine; API keys belong to the user (OpenRouter for AI, Zernio for publishing) and are paid per use.
- **Content with permission.** Only clip and monetize content you have the right to use (agreements with streamers, official clipping programs, your own content). Platforms penalize or demonetize reposts that add no value, so permission and original editing are part of the business model, not a detail.
- **Follow each platform's rules.** Duration, format and text limits, and requirements such as TikTok's pre-publish review.
- **Keep the MIT license** and credit BridgeMind as the upstream project.

## Out of scope (for now)

- A central server or backend: SparkClip remains a desktop app.
- Public installers: for now it runs from source.

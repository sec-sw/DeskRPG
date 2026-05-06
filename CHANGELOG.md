# Changelog

All notable changes to this project will be documented in this file.

This project follows a Keep a Changelog style workflow.
GitHub Releases will be written later at actual release time.

## [Unreleased]

### Added

- **Persistent channel attachments** with drag-drop upload, thumbnail
  generation, real-time list sync via socket, and per-file/per-channel
  storage quotas. Files can be shared into chat messages with inline
  preview, or browsed in a dedicated channel files panel.
- **Storage abstraction** with `STORAGE_DRIVER=local|s3` switch. S3-compatible
  drivers (AWS S3, Cloudflare R2, Backblaze B2, MinIO) get signed download
  URLs; local disk falls back to authenticated streaming.
- **LiveKit voice rooms** with per-channel toggle, member-only/open access
  modes, mic mute, listen-only fallback when the browser blocks the mic.
- **Camera + screen share** via the same voice connection. Screen shares
  appear in a floating viewer (multi-presenter dropdown, fullscreen). Camera
  tiles show in a small grid with self-mirror and mute badges.
- **Proximity voice** (opt-in per channel) — voice volume falls off with
  tile distance using LiveKit data channels for coordinate broadcast and
  a quadratic falloff curve. Configurable audible radius (1–30 tiles).
- **Voice settings tab** in channel settings (owner-only): toggle voice,
  access mode, proximity, and audible radius.
- **Channel storage usage bar** in the files panel.
- **Antivirus scan extension point** (`registerAVScanner`) — defaults to a
  no-op; operators wire ClamAV / cloud scanners as needed.
- **Attachments retention CLI** — `npm run attachments:cleanup -- --days 30`
  hard-deletes soft-deleted attachments older than the retention window.
- **Structured JSON event logs** for storage and voice operations.
- **`docker-compose.livekit.yml`** for self-hosted LiveKit alongside
  Postgres + DeskRPG.
- Channel owners can now delete meeting minutes from the minutes detail view.
- The meeting room sidebar can now be resized with a drag handle.
- The meeting start form now supports a collapsed settings panel.
- The meeting topic field now uses a multi-line textarea.

### Changed

- Meeting room metadata now reflects the active channel name.
- Meeting room start controls were simplified to show only the essential inputs by default.
- README screenshots and animated GIFs were refreshed and normalized to the same aspect ratio.

### Fixed

- Fixed duplicated NPC meeting messages during streamed discussions.
- Fixed streamed NPC responses disappearing when a turn completed.
- Fixed `SPEAK:` prefixes leaking into meeting room streaming and final messages.
- Fixed meeting room poll status rendering `[object Object]` for raised hands.
- Fixed meeting minutes parsing when SQLite returned JSON fields as strings.
- Fixed the active meeting chat panel so the input stays visible while messages scroll.

### Known Issues

- Some README GIF assets are larger than ideal and may need further optimization.

## Release Process

1. Keep new work under `Unreleased` while development is in progress.
2. At release time, move `Unreleased` items into a versioned section such as `## [0.1.1] - 2026-04-01`.
3. Create the git tag and publish the matching GitHub Release from that versioned section.
4. Start a fresh `Unreleased` section for the next cycle.

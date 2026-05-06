// src/lib/livekit-config.ts — env access + feature flag for LiveKit.
//
// All three of LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be
// set for the realtime media subsystem to be considered enabled. Token
// issuance and the voice-bar UI both gate on livekitConfigured().

export interface LiveKitConfig {
  /** ws:// or wss:// URL the server uses to mint tokens. */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Browser-facing URL; falls back to `url` when not separately set. */
  publicUrl: string;
}

export function livekitConfigured(): boolean {
  return Boolean(
    process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET,
  );
}

export function getLiveKitConfig(): LiveKitConfig {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      "LiveKit not configured — set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET",
    );
  }
  return {
    url,
    apiKey,
    apiSecret,
    publicUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL || url,
  };
}

/** Stable room-name derivation for a channel. Phase 2 will use this. */
export function liveKitRoomName(channelId: string): string {
  // LiveKit accepts arbitrary strings; namespacing keeps multi-tenant safe.
  return `deskrpg:channel:${channelId}`;
}

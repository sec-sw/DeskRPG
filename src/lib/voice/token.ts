// src/lib/voice/token.ts
//
// Mint LiveKit AccessTokens server-side. The browser never sees the API
// secret — it gets a short-lived JWT with narrow grants for one specific
// room.
//
// Token TTL is 6 hours by default — long enough for a working session
// without re-issuing, short enough to limit replay if a token leaks.

import { getLiveKitConfig } from "@/lib/livekit-config";

const DEFAULT_TOKEN_TTL_SECONDS = 6 * 60 * 60;

export interface VoiceTokenInput {
  /** LiveKit room name to grant access to. */
  roomName: string;
  /** Stable per-user identity (we use the DB userId). */
  identity: string;
  /** Display name shown to other participants. */
  displayName: string;
  /** Whether this user may publish their mic / camera / screen. */
  canPublish: boolean;
  /** Whether this user may subscribe to others' tracks. Almost always true. */
  canSubscribe: boolean;
  /**
   * Optional opaque metadata attached to the participant — visible to other
   * clients. We use it for character coordinates / proximity volume. Keep
   * small (<1KB).
   */
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
}

export interface VoiceTokenOutput {
  /** The signed JWT to pass to the LiveKit client. */
  token: string;
  /** Public ws/wss URL the browser should connect to. */
  url: string;
  /** Echoed for client convenience. */
  identity: string;
  /** Echoed for client convenience. */
  roomName: string;
  /** Echoed for client convenience. */
  expiresAt: string;
}

export async function mintVoiceToken(input: VoiceTokenInput): Promise<VoiceTokenOutput> {
  const cfg = getLiveKitConfig();
  // livekit-server-sdk has no peer dependencies, but we lazy-import so the
  // module isn't loaded on installs that don't enable LiveKit.
  const { AccessToken } = await import("livekit-server-sdk");
  const ttl = input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;

  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity: input.identity,
    name: input.displayName,
    ttl,
    metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
  });
  at.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: input.canPublish,
    canSubscribe: input.canSubscribe,
    canPublishData: true, // for proximity coordinate stream + future text-over-data
  });

  const token = await at.toJwt();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  return {
    token,
    url: cfg.publicUrl,
    identity: input.identity,
    roomName: input.roomName,
    expiresAt,
  };
}

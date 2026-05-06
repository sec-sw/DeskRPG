// src/app/api/channels/[id]/voice/token/route.ts
//
// POST → mint a LiveKit AccessToken for the channel's voice room.
//
// Flow:
//   1. Auth + RBAC against the voice room's access_mode.
//   2. Lazy-create voice_rooms row on first join.
//   3. Reject when the room is disabled by the owner.
//   4. Mint a JWT with narrow grants and return it alongside the public URL.
//
// The browser then connects via livekit-client SDK using the returned values.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, characters } from "@/db";
import { getUserId } from "@/lib/internal-rpc";
import { livekitConfigured } from "@/lib/livekit-config";
import { ensureVoiceRoom } from "@/lib/voice/room";
import { checkVoiceJoinAccess } from "@/lib/voice/access";
import { mintVoiceToken } from "@/lib/voice/token";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return jsonError(401, "unauthorized", "unauthorized");

  if (!livekitConfigured()) {
    return jsonError(503, "voice_not_configured", "Realtime voice is not configured");
  }

  const { id: channelId } = await params;

  // Ensure the row exists (with default settings) — this also fetches the
  // settings the access check needs.
  const room = await ensureVoiceRoom(channelId);
  if (!room.enabled) {
    return jsonError(403, "voice_disabled", "Voice is disabled in this channel");
  }

  const access = await checkVoiceJoinAccess(
    channelId,
    userId,
    (room.accessMode as "members" | "open") ?? "members",
  );
  if (!access.ok) return jsonError(access.status, access.reason, access.reason);

  // Prefer the user's selected character name when present — falls back to
  // their nickname so the caller still gets a sensible label.
  let displayName = access.ctx.characterName ?? "Player";
  const url = new URL(req.url);
  const characterId = url.searchParams.get("characterId");
  if (characterId) {
    const charRow = await db
      .select({ name: characters.name, userId: characters.userId })
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    if (charRow[0]?.userId === userId) {
      displayName = charRow[0].name;
    }
  }

  try {
    const token = await mintVoiceToken({
      roomName: room.livekitRoomName,
      identity: userId,
      displayName,
      canPublish: true,
      canSubscribe: true,
      metadata: { channelId, characterId: characterId ?? null },
    });
    return NextResponse.json({
      ...token,
      proximity: {
        enabled: !!room.proximityEnabled,
        radius: room.proximityRadius ?? 5,
      },
    });
  } catch (e) {
    console.error("Failed to mint voice token:", e);
    return jsonError(500, "internal_server_error", "Failed to issue token");
  }
}

function jsonError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ errorCode, error: message }, { status });
}

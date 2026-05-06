// src/app/api/channels/[id]/voice/route.ts
//
// GET   → fetch the voice room state (settings + whether realtime is configured).
//         Anyone with read access to the channel can see this.
// PATCH → update voice room settings. Owner / system_admin only.

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { livekitConfigured } from "@/lib/livekit-config";
import { ensureVoiceRoom, toVoiceRoomDTO, updateVoiceRoomSettings } from "@/lib/voice/room";
import { checkVoiceSettingsAccess } from "@/lib/voice/access";
import { checkChannelReadAccess } from "@/lib/attachments/access";
import { logEvent } from "@/lib/observability/events";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return jsonError(401, "unauthorized", "unauthorized");

  const { id: channelId } = await params;

  const access = await checkChannelReadAccess(channelId, userId);
  if (!access.ok) return jsonError(access.status, access.reason, access.reason);

  const row = await ensureVoiceRoom(channelId);
  return NextResponse.json({
    voice: toVoiceRoomDTO(row),
    livekitConfigured: livekitConfigured(),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return jsonError(401, "unauthorized", "unauthorized");

  const { id: channelId } = await params;

  const access = await checkVoiceSettingsAccess(channelId, userId);
  if (!access.ok) return jsonError(access.status, access.reason, access.reason);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid_json", "Invalid request body");
  }

  const patch: {
    enabled?: boolean;
    accessMode?: "members" | "open";
    proximityEnabled?: boolean;
    proximityRadius?: number;
  } = {};

  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.accessMode === "members" || body.accessMode === "open") {
    patch.accessMode = body.accessMode;
  }
  if (typeof body.proximityEnabled === "boolean") patch.proximityEnabled = body.proximityEnabled;
  if (typeof body.proximityRadius === "number") patch.proximityRadius = body.proximityRadius;

  const updated = await updateVoiceRoomSettings(channelId, patch);
  logEvent("voice.settings.updated", {
    channelId,
    userId,
    enabled: updated.enabled,
    accessMode: updated.accessMode,
    proximityEnabled: updated.proximityEnabled,
  });
  return NextResponse.json({ voice: toVoiceRoomDTO(updated) });
}

function jsonError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ errorCode, error: message }, { status });
}

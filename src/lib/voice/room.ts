// src/lib/voice/room.ts
//
// Voice room business logic: lazy lookup/create on first join, settings
// updates by channel owners, DTO shaping. The DB row exists only after the
// first token request — channels with no voice activity stay clean.
//
// LiveKit room creation itself is implicit: the SFU spins up rooms on first
// join and tears them down when the last participant leaves. We don't need
// to call CreateRoom or DeleteRoom from here.

import { eq } from "drizzle-orm";
import { db, isPostgres, voiceRooms } from "@/db";
import { liveKitRoomName } from "@/lib/livekit-config";

export type VoiceRoomRow = typeof voiceRooms.$inferSelect;

export interface VoiceRoomDTO {
  id: string;
  channelId: string;
  livekitRoomName: string;
  enabled: boolean;
  accessMode: "members" | "open";
  proximityEnabled: boolean;
  proximityRadius: number;
}

/**
 * Returns the existing voice room row for a channel, or null when none has
 * been provisioned yet. Read-only — does not create.
 */
export async function getVoiceRoom(channelId: string): Promise<VoiceRoomRow | null> {
  const rows = await db
    .select()
    .from(voiceRooms)
    .where(eq(voiceRooms.channelId, channelId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Returns the existing row, or creates one with default settings on first
 * call. Idempotent — concurrent callers race-safe via the unique index.
 */
export async function ensureVoiceRoom(channelId: string): Promise<VoiceRoomRow> {
  const existing = await getVoiceRoom(channelId);
  if (existing) return existing;

  const livekitRoom = liveKitRoomName(channelId);
  try {
    const [created] = await db
      .insert(voiceRooms)
      .values({
        channelId,
        livekitRoomName: livekitRoom,
      } as typeof voiceRooms.$inferInsert)
      .returning();
    return created;
  } catch {
    // Another request raced ahead and created it — fetch and return.
    const reread = await getVoiceRoom(channelId);
    if (reread) return reread;
    throw new Error(`Failed to ensure voice room for channel ${channelId}`);
  }
}

export interface VoiceRoomSettingsUpdate {
  enabled?: boolean;
  accessMode?: "members" | "open";
  proximityEnabled?: boolean;
  proximityRadius?: number;
}

const MIN_PROXIMITY_RADIUS = 1;
const MAX_PROXIMITY_RADIUS = 30;

export function clampProximityRadius(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(MIN_PROXIMITY_RADIUS, Math.min(MAX_PROXIMITY_RADIUS, Math.floor(value)));
}

/**
 * Owner-initiated settings update. Caller is responsible for verifying the
 * actor is the channel owner / system_admin before invoking.
 */
export async function updateVoiceRoomSettings(
  channelId: string,
  patch: VoiceRoomSettingsUpdate,
): Promise<VoiceRoomRow> {
  const row = await ensureVoiceRoom(channelId);
  const updates: Partial<typeof voiceRooms.$inferInsert> = {};

  if (typeof patch.enabled === "boolean") updates.enabled = patch.enabled;
  if (patch.accessMode === "members" || patch.accessMode === "open") {
    updates.accessMode = patch.accessMode;
  }
  if (typeof patch.proximityEnabled === "boolean") updates.proximityEnabled = patch.proximityEnabled;
  if (typeof patch.proximityRadius === "number") {
    updates.proximityRadius = clampProximityRadius(patch.proximityRadius);
  }

  if (Object.keys(updates).length === 0) return row;

  updates.updatedAt = (isPostgres ? new Date() : new Date().toISOString()) as
    | Date
    | string
    | undefined as never;

  const [updated] = await db
    .update(voiceRooms)
    .set(updates)
    .where(eq(voiceRooms.id, row.id))
    .returning();
  return updated;
}

export function toVoiceRoomDTO(row: VoiceRoomRow): VoiceRoomDTO {
  return {
    id: row.id,
    channelId: row.channelId,
    livekitRoomName: row.livekitRoomName,
    enabled: !!row.enabled,
    accessMode: (row.accessMode as "members" | "open") ?? "members",
    proximityEnabled: !!row.proximityEnabled,
    proximityRadius: row.proximityRadius ?? 5,
  };
}

// src/lib/voice/access.ts
//
// RBAC for voice rooms. Mirrors the attachment access model — joining/talking
// requires *participation* in the channel, listing settings requires read
// access, and changing settings requires channel ownership.

import { and, eq } from "drizzle-orm";
import {
  channelMembers,
  channels,
  db,
  groupMembers,
  users,
} from "@/db";
import {
  summarizeChannelDetailAccess,
  summarizeChannelParticipationAccess,
} from "@/lib/rbac/channel-access";

export type VoiceAccessReason =
  | "ok"
  | "channel_not_found"
  | "forbidden"
  | "not_a_member"
  | "password_required"
  | "voice_disabled";

export interface VoiceAccessContext {
  channelId: string;
  ownerId: string;
  groupId: string | null;
  isPublic: boolean;
  isOwner: boolean;
  isChannelMember: boolean;
  hasActiveGroupMembership: boolean;
  systemRole: string;
  characterName: string | null;
}

async function loadContext(
  channelId: string,
  userId: string,
): Promise<VoiceAccessContext | null> {
  const channelRows = await db
    .select({
      id: channels.id,
      ownerId: channels.ownerId,
      groupId: channels.groupId,
      isPublic: channels.isPublic,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (channelRows.length === 0) return null;
  const channel = channelRows[0];

  const [memberRows, groupMemberRows, userRows] = await Promise.all([
    db
      .select({ role: channelMembers.role })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
      .limit(1),
    channel.groupId
      ? db
        .select({ role: groupMembers.role })
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, channel.groupId), eq(groupMembers.userId, userId)))
        .limit(1)
      : Promise.resolve([] as { role: string }[]),
    db
      .select({ systemRole: users.systemRole, nickname: users.nickname })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);

  return {
    channelId,
    ownerId: channel.ownerId,
    groupId: channel.groupId ?? null,
    isPublic: channel.isPublic ?? true,
    isOwner: channel.ownerId === userId,
    isChannelMember: !!memberRows[0]?.role || channel.ownerId === userId,
    hasActiveGroupMembership: !!groupMemberRows[0]?.role,
    systemRole: userRows[0]?.systemRole ?? "user",
    characterName: userRows[0]?.nickname ?? null,
  };
}

export type VoiceJoinResult =
  | { ok: true; ctx: VoiceAccessContext }
  | { ok: false; reason: Exclude<VoiceAccessReason, "ok">; status: number };

/**
 * Can this user join the voice room? Requires channel participation. The
 * room's access_mode "open" relaxes membership to anyone with detail
 * (browse) access — used for public lobby-style rooms.
 */
export async function checkVoiceJoinAccess(
  channelId: string,
  userId: string,
  accessMode: "members" | "open",
): Promise<VoiceJoinResult> {
  const ctx = await loadContext(channelId, userId);
  if (!ctx) return { ok: false, reason: "channel_not_found", status: 404 };
  if (ctx.systemRole === "system_admin") return { ok: true, ctx };

  if (accessMode === "open") {
    const detail = summarizeChannelDetailAccess({
      groupId: ctx.groupId,
      isPublic: ctx.isPublic,
      hasActiveGroupMembership: ctx.hasActiveGroupMembership,
      isChannelMember: ctx.isChannelMember,
    });
    if (detail.allowed) return { ok: true, ctx };
    if (detail.reason === "legacy_private_password_required") {
      return { ok: false, reason: "password_required", status: 403 };
    }
    return { ok: false, reason: "forbidden", status: 403 };
  }

  const part = summarizeChannelParticipationAccess({
    groupId: ctx.groupId,
    isPublic: ctx.isPublic,
    hasActiveGroupMembership: ctx.hasActiveGroupMembership,
    isChannelMember: ctx.isChannelMember,
  });
  if (part.allowed) return { ok: true, ctx };
  if (part.reason === "password_required" || part.reason === "legacy_private_password_required") {
    return { ok: false, reason: "password_required", status: 403 };
  }
  return { ok: false, reason: "not_a_member", status: 403 };
}

export type VoiceSettingsAccessResult =
  | { ok: true; ctx: VoiceAccessContext }
  | { ok: false; reason: "channel_not_found" | "forbidden"; status: number };

/**
 * Settings updates (enable/disable, access mode, proximity) require channel
 * ownership or system admin.
 */
export async function checkVoiceSettingsAccess(
  channelId: string,
  userId: string,
): Promise<VoiceSettingsAccessResult> {
  const ctx = await loadContext(channelId, userId);
  if (!ctx) return { ok: false, reason: "channel_not_found", status: 404 };
  if (ctx.systemRole === "system_admin" || ctx.isOwner) return { ok: true, ctx };
  return { ok: false, reason: "forbidden", status: 403 };
}

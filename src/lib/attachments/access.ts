// src/lib/attachments/access.ts
//
// RBAC for channel attachments. Reuses the same membership rules as the
// rest of the channel APIs: ownership, channel_members, group_members.

import { and, eq } from "drizzle-orm";
import {
  attachments,
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

export type AttachmentAccessReason =
  | "ok"
  | "unauthorized"
  | "channel_not_found"
  | "attachment_not_found"
  | "forbidden"
  | "group_membership_required"
  | "password_required"
  | "not_a_member";

export interface ChannelAccessSummary {
  channelId: string;
  ownerId: string;
  groupId: string | null;
  isPublic: boolean;
  isOwner: boolean;
  isChannelMember: boolean;
  hasActiveGroupMembership: boolean;
  systemRole: string;
}

async function loadChannelContext(
  channelId: string,
  userId: string,
): Promise<ChannelAccessSummary | null> {
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

  const memberRows = await db
    .select({ role: channelMembers.role })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);

  const groupMemberRows = channel.groupId
    ? await db
      .select({ role: groupMembers.role })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, channel.groupId), eq(groupMembers.userId, userId)))
      .limit(1)
    : [];

  const userRows = await db
    .select({ systemRole: users.systemRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    channelId,
    ownerId: channel.ownerId,
    groupId: channel.groupId ?? null,
    isPublic: channel.isPublic ?? true,
    isOwner: channel.ownerId === userId,
    isChannelMember: !!memberRows[0]?.role || channel.ownerId === userId,
    hasActiveGroupMembership: !!groupMemberRows[0]?.role,
    systemRole: userRows[0]?.systemRole ?? "user",
  };
}

export type AttachmentReadAccess =
  | { ok: true; ctx: ChannelAccessSummary }
  | { ok: false; reason: Exclude<AttachmentAccessReason, "ok">; status: number };

/**
 * Read access mirrors the channel detail rules — anyone who could view the
 * channel can list/download its files. Browsers of public-but-non-member
 * channels deliberately *can* see the file list (matches DeskRPG's existing
 * "browse-only" behavior for groupless public channels).
 */
export async function checkChannelReadAccess(
  channelId: string,
  userId: string,
): Promise<AttachmentReadAccess> {
  const ctx = await loadChannelContext(channelId, userId);
  if (!ctx) return { ok: false, reason: "channel_not_found", status: 404 };

  if (ctx.systemRole === "system_admin") return { ok: true, ctx };

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
  return { ok: false, reason: "group_membership_required", status: 403 };
}

export type AttachmentWriteAccess =
  | { ok: true; ctx: ChannelAccessSummary }
  | { ok: false; reason: Exclude<AttachmentAccessReason, "ok">; status: number };

/**
 * Write access (upload, delete) requires *participation* — i.e. the user can
 * actually be in the channel. Browsing rights aren't enough.
 */
export async function checkChannelWriteAccess(
  channelId: string,
  userId: string,
): Promise<AttachmentWriteAccess> {
  const ctx = await loadChannelContext(channelId, userId);
  if (!ctx) return { ok: false, reason: "channel_not_found", status: 404 };
  if (ctx.systemRole === "system_admin") return { ok: true, ctx };

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

/**
 * Delete authorization: channel owner, system admin, or the original uploader.
 */
export function canDeleteAttachment(
  ctx: ChannelAccessSummary,
  attachmentUploaderId: string,
  userId: string,
): boolean {
  if (ctx.systemRole === "system_admin") return true;
  if (ctx.isOwner) return true;
  return attachmentUploaderId === userId;
}

/**
 * Loads an attachment row by id, applying the read-access rules of its
 * containing channel. Returns either the row + access ctx or a typed denial.
 */
export type AttachmentReadResult =
  | {
      ok: true;
      attachment: typeof attachments.$inferSelect;
      ctx: ChannelAccessSummary;
    }
  | { ok: false; reason: Exclude<AttachmentAccessReason, "ok">; status: number };

export async function loadAttachmentForRead(
  attachmentId: string,
  userId: string,
): Promise<AttachmentReadResult> {
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  if (rows.length === 0 || rows[0].deletedAt) {
    return { ok: false, reason: "attachment_not_found", status: 404 };
  }
  const attachment = rows[0];
  const access = await checkChannelReadAccess(attachment.channelId, userId);
  if (!access.ok) return access;
  return { ok: true, attachment, ctx: access.ctx };
}

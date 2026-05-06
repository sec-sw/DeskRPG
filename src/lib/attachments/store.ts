// src/lib/attachments/store.ts
//
// Higher-level orchestration: write to the storage driver + DB row in lock-step,
// roll back partial writes on failure, expose query helpers for quota and
// listing. Routes call into here so they only contain HTTP concerns.

import { and, desc, eq, isNull, sum } from "drizzle-orm";
import path from "node:path";
import type { Readable } from "node:stream";
import { attachments, db, isPostgres, jsonForDb } from "@/db";
import { getStorage, attachmentKey, thumbnailKey, StorageNotFound } from "@/lib/storage";
import type { StorageDriver } from "@/lib/storage";
import { scanForMalware, shouldRejectByVerdict } from "@/lib/storage/av-scanner";
import {
  getAttachmentFileMaxBytes,
  getChannelQuotaBytes,
  validateAttachmentFileSize,
  validateChannelQuota,
  type UploadLimitErrorCode,
} from "@/lib/upload-limits";

export interface CreateAttachmentInput {
  channelId: string;
  uploaderId: string;
  filename: string;
  contentType: string;
  body: Buffer | Readable;
  /**
   * Required when `body` is a stream. When `body` is a Buffer the byteLength
   * is used and this can be omitted. Used for both quota pre-check and the
   * S3 driver's content-length header.
   */
  byteLengthHint?: number;
  metadata?: Record<string, unknown>;
}

export type AttachmentRow = typeof attachments.$inferSelect;

export interface AttachmentDTO {
  id: string;
  channelId: string;
  uploaderId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  hasThumbnail: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type CreateAttachmentResult =
  | { ok: true; attachment: AttachmentDTO }
  | { ok: false; errorCode: UploadLimitErrorCode | "attachment_infected" };

export class AttachmentStorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AttachmentStorageError";
  }
}

/**
 * Total non-deleted bytes stored under a channel. Used for quota enforcement.
 */
export async function getChannelStorageBytes(channelId: string): Promise<number> {
  const rows = await db
    .select({ total: sum(attachments.byteSize) })
    .from(attachments)
    .where(and(eq(attachments.channelId, channelId), isNull(attachments.deletedAt)));
  // sum() returns string|null in PG; SQLite returns number|null.
  const raw = rows[0]?.total;
  if (raw == null) return 0;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Atomically check quota → put bytes → insert row. If the storage put
 * succeeds but the DB insert fails, the orphan blob is best-effort deleted.
 */
export async function createAttachment(
  input: CreateAttachmentInput,
): Promise<CreateAttachmentResult> {
  const driver = getStorage();

  // File-size pre-check from hint (cheap, before any IO).
  const declaredSize =
    input.byteLengthHint ??
    (Buffer.isBuffer(input.body) ? input.body.byteLength : undefined);

  if (declaredSize != null) {
    const fileErr = validateAttachmentFileSize(declaredSize);
    if (fileErr) return { ok: false, errorCode: fileErr };

    const currentBytes = await getChannelStorageBytes(input.channelId);
    const quotaErr = validateChannelQuota(currentBytes, declaredSize);
    if (quotaErr) return { ok: false, errorCode: quotaErr };
  }

  // Allocate the row id up front so the storage key can reference it.
  // We don't INSERT yet — only after the bytes land successfully.
  // crypto.randomUUID is available in Node 18+ and matches schema-sqlite.ts.
  const attachmentId = globalThis.crypto.randomUUID();
  const ext = path.extname(input.filename);
  const key = attachmentKey(input.channelId, attachmentId, ext);

  let putResult;
  try {
    putResult = await driver.put(key, input.body, {
      contentType: input.contentType,
      filename: input.filename,
      contentLength: declaredSize,
    });
  } catch (e) {
    throw new AttachmentStorageError("Failed to write attachment to storage", e);
  }

  // Post-write size verification. Stream uploads might exceed the hint —
  // catch that here and roll back.
  const postFileErr = validateAttachmentFileSize(putResult.size);
  if (postFileErr) {
    await driver.delete(key).catch(() => undefined);
    return { ok: false, errorCode: postFileErr };
  }
  // Re-check quota with the *actual* size now that we know it. This races with
  // concurrent uploads; the worst case is a slight quota overshoot which
  // Phase 6 will tighten via DB-level reservation.
  const liveBytes = await getChannelStorageBytes(input.channelId);
  const postQuotaErr = validateChannelQuota(liveBytes, putResult.size);
  if (postQuotaErr) {
    await driver.delete(key).catch(() => undefined);
    return { ok: false, errorCode: postQuotaErr };
  }

  // AV scan after the bytes have landed but before the row is recorded. The
  // default scanner is a no-op until an operator registers one; on infection
  // we delete the orphan blob and reject the upload with a stable code.
  const verdict = await scanForMalware({
    key,
    contentType: input.contentType,
    byteSize: putResult.size,
    body: async () => {
      const got = await driver.get(key);
      const chunks: Buffer[] = [];
      for await (const chunk of got.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
  });
  if (shouldRejectByVerdict(verdict)) {
    await driver.delete(key).catch(() => undefined);
    return { ok: false, errorCode: "attachment_infected" };
  }

  let row: AttachmentRow;
  try {
    const inserted = await db
      .insert(attachments)
      .values({
        id: attachmentId,
        channelId: input.channelId,
        uploaderId: input.uploaderId,
        filename: input.filename,
        contentType: input.contentType,
        byteSize: putResult.size,
        sha256: putResult.sha256,
        storageDriver: driver.name,
        storageKey: key,
        thumbnailKey: null,
        metadata: jsonForDb(input.metadata ?? {}),
      } as typeof attachments.$inferInsert)
      .returning();
    row = inserted[0];
  } catch (e) {
    await driver.delete(key).catch(() => undefined);
    throw new AttachmentStorageError("Failed to record attachment in database", e);
  }

  return { ok: true, attachment: toDTO(row) };
}

export async function listChannelAttachments(
  channelId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<AttachmentDTO[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.channelId, channelId), isNull(attachments.deletedAt)))
    .orderBy(desc(attachments.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map(toDTO);
}

export async function setThumbnailKey(
  attachmentId: string,
  key: string | null,
): Promise<void> {
  await db
    .update(attachments)
    .set({ thumbnailKey: key })
    .where(eq(attachments.id, attachmentId));
}

/**
 * Soft delete: sets deleted_at, then best-effort removes the bytes and the
 * thumbnail from storage. Reads after this point will return 404.
 */
export async function softDeleteAttachment(attachmentId: string): Promise<boolean> {
  const driver = getStorage();
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  if (rows.length === 0 || rows[0].deletedAt) return false;
  const row = rows[0];

  const now = isPostgres ? new Date() : new Date().toISOString();
  await db
    .update(attachments)
    .set({ deletedAt: now as unknown as Date })
    .where(eq(attachments.id, attachmentId));

  await driver.delete(row.storageKey).catch(() => undefined);
  if (row.thumbnailKey) {
    await driver.delete(row.thumbnailKey).catch(() => undefined);
  }
  return true;
}

export function toDTO(row: AttachmentRow): AttachmentDTO {
  return {
    id: row.id,
    channelId: row.channelId,
    uploaderId: row.uploaderId,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    hasThumbnail: !!row.thumbnailKey,
    metadata: parseMetadata(row.metadata),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

// Re-exported helpers consumers may want — keeps imports cohesive.
export {
  getAttachmentFileMaxBytes,
  getChannelQuotaBytes,
  thumbnailKey,
  attachmentKey,
  StorageNotFound,
};
export type { StorageDriver };

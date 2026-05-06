// src/app/api/attachments/[id]/route.ts
//
// GET    → download an attachment. Redirects to a signed URL when the storage
//          driver supports it (S3/CDN); otherwise streams the bytes through
//          this server with auth still enforced.
// DELETE → soft-delete (uploader, channel owner, or system_admin only).

import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import {
  canDeleteAttachment,
  loadAttachmentForRead,
} from "@/lib/attachments/access";
import { softDeleteAttachment } from "@/lib/attachments/store";
import { getStorage, StorageNotFound } from "@/lib/storage";
import { logEvent } from "@/lib/observability/events";
import internalTransport from "@/lib/internal-transport.js";

const { buildInternalAuthHeaders, getInternalSocketBaseUrl } = internalTransport as {
  buildInternalAuthHeaders: () => Record<string, string>;
  getInternalSocketBaseUrl: () => string;
};

const SIGNED_URL_TTL_SECONDS = 5 * 60;

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return jsonError(401, "unauthorized", "unauthorized");

  const { id } = await params;
  const result = await loadAttachmentForRead(id, userId);
  if (!result.ok) return jsonError(result.status, result.reason, result.reason);

  const { attachment } = result;
  const driver = getStorage();

  // Try the driver's signed-URL path first — for S3/R2/B2/CDN, this lets the
  // browser pull bytes directly without proxying through Node.
  const signedUrl = await driver.signedDownloadUrl(attachment.storageKey, {
    ttlSeconds: SIGNED_URL_TTL_SECONDS,
    downloadFilename: attachment.filename,
  });
  if (signedUrl) {
    return NextResponse.redirect(signedUrl, 302);
  }

  // Fallback: stream through this route with the same auth check above.
  let got;
  try {
    got = await driver.get(attachment.storageKey);
  } catch (e) {
    if (e instanceof StorageNotFound) {
      return jsonError(404, "attachment_not_found", "attachment_not_found");
    }
    throw e;
  }

  const webStream = Readable.toWeb(got.body) as unknown as ReadableStream<Uint8Array>;
  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": got.contentType,
      "Content-Length": String(attachment.byteSize),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      // Prevent script execution from user-uploaded HTML/SVG.
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    },
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return jsonError(401, "unauthorized", "unauthorized");

  const { id } = await params;
  const result = await loadAttachmentForRead(id, userId);
  if (!result.ok) return jsonError(result.status, result.reason, result.reason);

  if (!canDeleteAttachment(result.ctx, result.attachment.uploaderId, userId)) {
    return jsonError(403, "forbidden", "forbidden");
  }

  const ok = await softDeleteAttachment(id);
  if (!ok) return jsonError(404, "attachment_not_found", "attachment_not_found");

  logEvent("attachment.deleted", {
    channelId: result.attachment.channelId,
    attachmentId: id,
    deletedBy: userId,
    byteSize: result.attachment.byteSize,
  });

  // Notify the channel room so other clients drop the file from their UI.
  try {
    await fetch(`${getInternalSocketBaseUrl()}/_internal/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildInternalAuthHeaders() },
      body: JSON.stringify({
        event: "attachment:deleted",
        room: result.attachment.channelId,
        payload: { attachmentId: id, channelId: result.attachment.channelId },
      }),
    });
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ success: true });
}

function jsonError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ errorCode, error: message }, { status });
}

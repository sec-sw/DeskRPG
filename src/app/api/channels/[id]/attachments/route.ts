// src/app/api/channels/[id]/attachments/route.ts
//
// POST  → upload a new channel-shared attachment
// GET   → list non-deleted attachments for a channel (paginated)
//
// Both gate on the channel's RBAC rules. Uploads also enforce per-file size
// and per-channel storage quota.

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import {
  checkChannelReadAccess,
  checkChannelWriteAccess,
} from "@/lib/attachments/access";
import {
  createAttachment,
  listChannelAttachments,
} from "@/lib/attachments/store";
import { getAttachmentFileMaxBytes } from "@/lib/upload-limits";
import internalTransport from "@/lib/internal-transport.js";

const { buildInternalAuthHeaders, getInternalSocketBaseUrl } = internalTransport as {
  buildInternalAuthHeaders: () => Record<string, string>;
  getInternalSocketBaseUrl: () => string;
};

export const runtime = "nodejs"; // Next.js Edge can't host sharp/sqlite/sdk imports.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return jsonError(401, "unauthorized", "unauthorized");

  const { id: channelId } = await params;

  const access = await checkChannelWriteAccess(channelId, userId);
  if (!access.ok) return jsonError(access.status, access.reason, access.reason);

  // Cheap pre-check: bail before reading the body when content-length is
  // already over the cap. The actual per-file enforcement happens inside
  // createAttachment with the real byte count too.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  const fileMax = getAttachmentFileMaxBytes();
  if (contentLength > 0 && contentLength > fileMax * 1.05) {
    // 5% slack for multipart envelope overhead.
    return jsonError(413, "attachment_file_too_large", "Attachment exceeds the per-file size limit");
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError(400, "invalid_json", "invalid multipart body");
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return jsonError(400, "file_required", "File is required");
  }

  const filename = sanitizeFilename(file.name) || "untitled";
  const contentType = file.type || "application/octet-stream";
  const arrayBuf = await file.arrayBuffer();
  const body = Buffer.from(arrayBuf);

  const result = await createAttachment({
    channelId,
    uploaderId: userId,
    filename,
    contentType,
    body,
  });
  if (!result.ok) {
    const status = result.errorCode === "channel_quota_exceeded" ? 409 : 413;
    return jsonError(status, result.errorCode, result.errorCode);
  }

  // Best-effort socket fanout so other clients see the new file in real time.
  // Non-fatal if it fails — the file is already persisted.
  try {
    await fetch(`${getInternalSocketBaseUrl()}/_internal/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildInternalAuthHeaders() },
      body: JSON.stringify({
        event: "attachment:created",
        room: channelId,
        payload: { attachment: result.attachment },
      }),
    });
  } catch {
    /* non-critical */
  }

  return NextResponse.json({ attachment: result.attachment }, { status: 201 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return jsonError(401, "unauthorized", "unauthorized");

  const { id: channelId } = await params;

  const access = await checkChannelReadAccess(channelId, userId);
  if (!access.ok) return jsonError(access.status, access.reason, access.reason);

  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const items = await listChannelAttachments(channelId, {
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return NextResponse.json({ items });
}

function jsonError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ errorCode, error: message }, { status });
}

function sanitizeFilename(raw: string): string {
  // Strip path separators and control chars; preserve unicode names.
  const noPath = raw.replace(/[\\/]/g, "_");
  const noCtl = noPath.replace(/[\x00-\x1f\x7f]/g, "");
  return noCtl.slice(0, 200).trim();
}

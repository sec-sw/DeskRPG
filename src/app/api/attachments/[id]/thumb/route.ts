// src/app/api/attachments/[id]/thumb/route.ts
//
// On-demand WebP thumbnail (320×320 cover-fit) for image attachments.
// Generated on first request and cached via the storage driver. Returns 404
// for non-images.

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { loadAttachmentForRead } from "@/lib/attachments/access";
import { getOrCreateThumbnail } from "@/lib/attachments/thumbnail";

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

  const thumb = await getOrCreateThumbnail(result.attachment);
  if (!thumb) {
    return jsonError(404, "not_found", "thumbnail unavailable");
  }

  // Buffer is BodyInit-compatible at runtime, but TS marks Buffer.buffer as
  // ArrayBufferLike (union with SharedArrayBuffer) which Next's strict types
  // reject. The cast is safe — sharp always returns a non-shared ArrayBuffer.
  return new NextResponse(thumb.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": thumb.contentType,
      "Content-Length": String(thumb.size),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function jsonError(status: number, errorCode: string, message: string) {
  return NextResponse.json({ errorCode, error: message }, { status });
}

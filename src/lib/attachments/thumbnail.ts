// src/lib/attachments/thumbnail.ts
//
// On-demand thumbnail generation for image attachments. We lazily produce a
// 320x320 webp (cover-fit) the first time a thumbnail is requested, persist
// it through the storage driver under thumbnailKey(...), and update the row
// so subsequent requests skip regeneration.
//
// Sharp is already a project dependency. WebP keeps thumbnails small for
// chat panels and file lists.

import type { Readable } from "node:stream";
import type { AttachmentRow } from "./store";
import { setThumbnailKey } from "./store";
import { getStorage, thumbnailKey } from "@/lib/storage";

const THUMBNAIL_DIMENSION = 320;
const THUMBNAIL_QUALITY = 80;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
]);

export function isThumbnailable(contentType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(contentType.toLowerCase());
}

export interface ThumbnailResult {
  body: Buffer;
  contentType: "image/webp";
  size: number;
}

/**
 * Returns the cached thumbnail when present, otherwise generates and caches
 * one. Returns null when the row is not an image we can thumbnail or when
 * the source bytes are no longer available.
 */
export async function getOrCreateThumbnail(row: AttachmentRow): Promise<ThumbnailResult | null> {
  if (!isThumbnailable(row.contentType)) return null;

  const driver = getStorage();

  // Fast path: thumbnail already exists.
  if (row.thumbnailKey) {
    try {
      const got = await driver.get(row.thumbnailKey);
      const body = await readAll(got.body);
      return { body, contentType: "image/webp", size: body.byteLength };
    } catch {
      // Cache miss in storage — fall through to regenerate.
    }
  }

  // Slow path: regenerate from the source.
  let source;
  try {
    source = await driver.get(row.storageKey);
  } catch {
    return null;
  }
  const sourceBuffer = await readAll(source.body);

  const sharp = await import("sharp");
  const webp = await sharp
    .default(sourceBuffer, { failOn: "none" })
    .rotate() // honor EXIF orientation
    .resize({
      width: THUMBNAIL_DIMENSION,
      height: THUMBNAIL_DIMENSION,
      fit: "cover",
      withoutEnlargement: true,
    })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();

  const key = thumbnailKey(row.channelId, row.id);
  await driver.put(key, webp, { contentType: "image/webp", filename: `${row.id}.webp` });
  await setThumbnailKey(row.id, key);
  return { body: webp, contentType: "image/webp", size: webp.byteLength };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

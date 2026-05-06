// src/lib/storage/types.ts — driver-agnostic storage contract.
//
// Everything stored under DeskRPG (channel attachments, future minutes
// transcripts, etc.) goes through this interface so the rest of the app does
// not need to care whether the bytes live on local disk or in S3-compatible
// object storage. Keys are forward-slash POSIX paths, opaque to callers.

import type { Readable } from "node:stream";

export type StorageDriverName = "local" | "s3";

export interface PutOptions {
  /** MIME type recorded with the object. Defaults to application/octet-stream. */
  contentType?: string;
  /** Original filename — used for Content-Disposition on signed downloads. */
  filename?: string;
  /** Size hint when streaming bodies; required for some S3 paths. */
  contentLength?: number;
}

export interface PutResult {
  key: string;
  size: number;
  /** Hex-encoded SHA-256 of the stored bytes. */
  sha256: string;
}

export interface HeadResult {
  key: string;
  size: number;
  contentType: string;
  /** Hex-encoded SHA-256 if the driver computed one at upload time. */
  sha256?: string;
  /** Last-modified epoch ms. */
  lastModifiedMs: number;
}

export interface GetResult {
  body: Readable;
  size: number;
  contentType: string;
  lastModifiedMs: number;
}

export interface SignedUrlOptions {
  ttlSeconds: number;
  /** When set, response Content-Disposition forces a filename. */
  downloadFilename?: string;
}

export interface StorageDriver {
  readonly name: StorageDriverName;

  /** Persist bytes under `key`. Streams or buffers both supported. */
  put(key: string, body: Buffer | Readable, options?: PutOptions): Promise<PutResult>;

  /** Open a read stream for `key`. Throws StorageNotFound if missing. */
  get(key: string): Promise<GetResult>;

  /** Lightweight existence + metadata check. Returns null when missing. */
  head(key: string): Promise<HeadResult | null>;

  /** Idempotent — succeeds even if the key is already gone. */
  delete(key: string): Promise<void>;

  /**
   * Best-effort signed download URL. Returns null when the driver cannot
   * issue a real signed URL (e.g. local disk) — callers should then fall
   * back to streaming through an authenticated API route.
   */
  signedDownloadUrl(key: string, options: SignedUrlOptions): Promise<string | null>;
}

export class StorageNotFound extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageNotFound";
  }
}

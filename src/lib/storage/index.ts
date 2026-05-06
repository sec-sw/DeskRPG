// src/lib/storage/index.ts — driver factory + key helpers.
//
// Singleton pattern: getStorage() reads env once, caches the driver. Tests can
// reset via resetStorageForTests().

import path from "node:path";
import { getDeskRpgAttachmentsDir } from "../runtime-paths";
import type { StorageDriver, StorageDriverName } from "./types";
import { LocalStorageDriver } from "./local-driver";
import { S3StorageDriver } from "./s3-driver";

export type { StorageDriver, PutOptions, PutResult, HeadResult, GetResult, SignedUrlOptions } from "./types";
export { StorageNotFound } from "./types";

let _driver: StorageDriver | null = null;

function readDriverName(): StorageDriverName {
  const raw = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();
  if (raw === "s3") return "s3";
  return "local";
}

function buildDriver(): StorageDriver {
  const name = readDriverName();
  if (name === "s3") {
    const bucket = required("S3_BUCKET");
    return new S3StorageDriver({
      bucket,
      region: process.env.S3_REGION ?? "auto",
      endpoint: emptyToUndefined(process.env.S3_ENDPOINT),
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: parseBool(process.env.S3_FORCE_PATH_STYLE, true),
      publicBaseUrl: emptyToUndefined(process.env.S3_PUBLIC_BASE_URL),
    });
  }
  return new LocalStorageDriver({
    rootDir: process.env.STORAGE_LOCAL_DIR || getDeskRpgAttachmentsDir(),
  });
}

export function getStorage(): StorageDriver {
  if (!_driver) _driver = buildDriver();
  return _driver;
}

export function resetStorageForTests(): void {
  _driver = null;
}

/**
 * Test-only override. Production callers must use getStorage().
 */
export function setStorageForTests(driver: StorageDriver | null): void {
  _driver = driver;
}

// ── Key helpers ────────────────────────────────────────────────────────
// Storage keys are POSIX-style. Always use these helpers so layout stays
// consistent across drivers + future migration tooling.

export function attachmentKey(channelId: string, attachmentId: string, ext: string): string {
  const safeExt = sanitizeExt(ext);
  return path.posix.join("channels", channelId, "files", `${attachmentId}${safeExt}`);
}

export function thumbnailKey(channelId: string, attachmentId: string): string {
  return path.posix.join("channels", channelId, "thumbs", `${attachmentId}.webp`);
}

function sanitizeExt(ext: string): string {
  if (!ext) return "";
  const cleaned = ext.replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  if (!cleaned) return "";
  return cleaned.startsWith(".") ? cleaned : `.${cleaned}`;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function emptyToUndefined(v: string | undefined): string | undefined {
  return v && v.length > 0 ? v : undefined;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.toLowerCase().trim();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

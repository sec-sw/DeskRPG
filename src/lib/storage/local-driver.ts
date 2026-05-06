// src/lib/storage/local-driver.ts — disk-backed StorageDriver.
//
// Layout: <root>/<key>  where <key> is a POSIX-style relative path.
// Metadata sidecar: <root>/<key>.meta.json holds { contentType, sha256, size }
// so head() can answer without re-hashing the body.

import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform, pipeline } from "node:stream";
import { promisify } from "node:util";
import type {
  GetResult,
  HeadResult,
  PutOptions,
  PutResult,
  SignedUrlOptions,
  StorageDriver,
} from "./types";
import { StorageNotFound } from "./types";

const pipelineAsync = promisify(pipeline);

interface MetaSidecar {
  contentType: string;
  sha256: string;
  size: number;
}

export interface LocalDriverOptions {
  /** Absolute path of the storage root. Created on first use. */
  rootDir: string;
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = "local" as const;
  private readonly rootDir: string;

  constructor(options: LocalDriverOptions) {
    this.rootDir = path.resolve(options.rootDir);
  }

  async put(key: string, body: Buffer | Readable, options: PutOptions = {}): Promise<PutResult> {
    const absPath = this.resolveKey(key);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    const hash = crypto.createHash("sha256");
    let size = 0;

    if (Buffer.isBuffer(body)) {
      hash.update(body);
      size = body.byteLength;
      await fs.writeFile(absPath, body);
    } else {
      // Streaming path: tap each chunk into the hash + size counter while
      // forwarding it to disk in a single pipeline.
      const counted = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          size += chunk.byteLength;
          cb(null, chunk);
        },
      });
      await pipelineAsync(body, counted, createWriteStream(absPath));
    }

    const sha256 = hash.digest("hex");
    const meta: MetaSidecar = {
      contentType: options.contentType ?? "application/octet-stream",
      sha256,
      size,
    };
    await fs.writeFile(this.metaPathFor(absPath), JSON.stringify(meta));

    return { key, size, sha256 };
  }

  async get(key: string): Promise<GetResult> {
    const absPath = this.resolveKey(key);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat || !stat.isFile()) throw new StorageNotFound(key);

    const meta = await this.readMeta(absPath);
    return {
      body: createReadStream(absPath),
      size: stat.size,
      contentType: meta?.contentType ?? "application/octet-stream",
      lastModifiedMs: stat.mtimeMs,
    };
  }

  async head(key: string): Promise<HeadResult | null> {
    const absPath = this.resolveKey(key);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat || !stat.isFile()) return null;

    const meta = await this.readMeta(absPath);
    return {
      key,
      size: stat.size,
      contentType: meta?.contentType ?? "application/octet-stream",
      sha256: meta?.sha256,
      lastModifiedMs: stat.mtimeMs,
    };
  }

  async delete(key: string): Promise<void> {
    const absPath = this.resolveKey(key);
    await Promise.all([
      fs.rm(absPath, { force: true }),
      fs.rm(this.metaPathFor(absPath), { force: true }),
    ]);
  }

  /**
   * Local disk has no real signed URLs. Callers must stream through an
   * authenticated route — returning null signals that to the caller.
   */
  async signedDownloadUrl(_key: string, _options: SignedUrlOptions): Promise<string | null> {
    return null;
  }

  private resolveKey(key: string): string {
    // Reject path traversal and absolute keys — keys are relative POSIX.
    if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\")) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path.join(this.rootDir, key);
  }

  private metaPathFor(absPath: string): string {
    return `${absPath}.meta.json`;
  }

  private async readMeta(absPath: string): Promise<MetaSidecar | null> {
    const raw = await fs.readFile(this.metaPathFor(absPath), "utf8").catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MetaSidecar;
    } catch {
      return null;
    }
  }
}

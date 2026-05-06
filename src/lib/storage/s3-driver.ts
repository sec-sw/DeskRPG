// src/lib/storage/s3-driver.ts — S3-compatible StorageDriver.
//
// Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, etc. by treating
// the endpoint and force-path-style flag as configurable.
//
// We require @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner — both
// Apache-2.0, license-compatible with DeskRPG SUL.

import crypto from "node:crypto";
import { Readable } from "node:stream";
import type {
  GetResult,
  HeadResult,
  PutOptions,
  PutResult,
  SignedUrlOptions,
  StorageDriver,
} from "./types";
import { StorageNotFound } from "./types";

export interface S3DriverOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for non-AWS providers (R2/B2/MinIO). Omit for AWS. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for MinIO and most non-AWS providers. */
  forcePathStyle?: boolean;
  /**
   * If set, signedDownloadUrl() returns `${publicBaseUrl}/${key}` directly
   * (no signing) for objects intended to be served via CDN.
   */
  publicBaseUrl?: string;
}

interface SdkBundle {
  client: import("@aws-sdk/client-s3").S3Client;
  GetObjectCommand: typeof import("@aws-sdk/client-s3").GetObjectCommand;
  PutObjectCommand: typeof import("@aws-sdk/client-s3").PutObjectCommand;
  HeadObjectCommand: typeof import("@aws-sdk/client-s3").HeadObjectCommand;
  DeleteObjectCommand: typeof import("@aws-sdk/client-s3").DeleteObjectCommand;
  getSignedUrl: typeof import("@aws-sdk/s3-request-presigner").getSignedUrl;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = "s3" as const;
  private readonly options: S3DriverOptions;
  private _sdk: SdkBundle | null = null;

  constructor(options: S3DriverOptions) {
    this.options = options;
  }

  private async sdk(): Promise<SdkBundle> {
    if (this._sdk) return this._sdk;
    const s3 = await import("@aws-sdk/client-s3");
    const presigner = await import("@aws-sdk/s3-request-presigner");
    const client = new s3.S3Client({
      region: this.options.region,
      endpoint: this.options.endpoint,
      forcePathStyle: this.options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      },
    });
    this._sdk = {
      client,
      GetObjectCommand: s3.GetObjectCommand,
      PutObjectCommand: s3.PutObjectCommand,
      HeadObjectCommand: s3.HeadObjectCommand,
      DeleteObjectCommand: s3.DeleteObjectCommand,
      getSignedUrl: presigner.getSignedUrl,
    };
    return this._sdk;
  }

  async put(key: string, body: Buffer | Readable, options: PutOptions = {}): Promise<PutResult> {
    this.assertKey(key);
    const { client, PutObjectCommand } = await this.sdk();

    // S3 PutObject accepts a Buffer or stream; we hash the buffer up front
    // when given one. For streams, we tee through a hash transform.
    let payload: Buffer | Readable;
    let size = options.contentLength ?? 0;
    let sha256: string;

    if (Buffer.isBuffer(body)) {
      payload = body;
      size = body.byteLength;
      sha256 = crypto.createHash("sha256").update(body).digest("hex");
    } else {
      // Buffer the stream so we can compute SHA-256 + content-length before
      // calling PutObject. Keeps the contract simple at v1; chunked upload
      // for very large files is a Phase-6 concern.
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffered = Buffer.concat(chunks);
      payload = buffered;
      size = buffered.byteLength;
      sha256 = crypto.createHash("sha256").update(buffered).digest("hex");
    }

    await client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: payload,
        ContentType: options.contentType ?? "application/octet-stream",
        ContentLength: size,
        Metadata: { sha256 },
      }),
    );

    return { key, size, sha256 };
  }

  async get(key: string): Promise<GetResult> {
    this.assertKey(key);
    const { client, GetObjectCommand } = await this.sdk();
    try {
      const out = await client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      const body = out.Body as Readable | undefined;
      if (!body) throw new StorageNotFound(key);
      return {
        body,
        size: typeof out.ContentLength === "number" ? out.ContentLength : 0,
        contentType: out.ContentType ?? "application/octet-stream",
        lastModifiedMs: out.LastModified?.getTime() ?? Date.now(),
      };
    } catch (e: unknown) {
      if (isNoSuchKey(e)) throw new StorageNotFound(key);
      throw e;
    }
  }

  async head(key: string): Promise<HeadResult | null> {
    this.assertKey(key);
    const { client, HeadObjectCommand } = await this.sdk();
    try {
      const out = await client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return {
        key,
        size: typeof out.ContentLength === "number" ? out.ContentLength : 0,
        contentType: out.ContentType ?? "application/octet-stream",
        sha256: (out.Metadata?.sha256 as string | undefined) ?? undefined,
        lastModifiedMs: out.LastModified?.getTime() ?? Date.now(),
      };
    } catch (e: unknown) {
      if (isNoSuchKey(e) || isNotFoundStatus(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key);
    const { client, DeleteObjectCommand } = await this.sdk();
    await client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async signedDownloadUrl(key: string, options: SignedUrlOptions): Promise<string | null> {
    this.assertKey(key);
    if (this.options.publicBaseUrl) {
      const base = this.options.publicBaseUrl.replace(/\/+$/, "");
      return `${base}/${encodeURI(key)}`;
    }
    const { client, GetObjectCommand, getSignedUrl } = await this.sdk();
    const cmd = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ResponseContentDisposition: options.downloadFilename
        ? `attachment; filename="${sanitizeFilename(options.downloadFilename)}"`
        : undefined,
    });
    return getSignedUrl(client, cmd, { expiresIn: options.ttlSeconds });
  }

  private assertKey(key: string): void {
    if (!key || key.startsWith("/") || key.includes("..")) {
      throw new Error(`Invalid storage key: ${key}`);
    }
  }
}

function isNoSuchKey(e: unknown): boolean {
  return typeof e === "object" && e !== null && "name" in e && (e as { name: string }).name === "NoSuchKey";
}

function isNotFoundStatus(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const meta = (e as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode === 404;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_");
}

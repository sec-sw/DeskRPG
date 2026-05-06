// src/lib/storage/local-driver.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import crypto from "node:crypto";

import { LocalStorageDriver } from "./local-driver";
import { StorageNotFound } from "./types";

async function freshRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-storage-"));
  return dir;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("LocalStorageDriver: put + get + head + delete (buffer)", async () => {
  const root = await freshRoot();
  try {
    const driver = new LocalStorageDriver({ rootDir: root });
    const body = Buffer.from("hello world");
    const put = await driver.put("channels/c1/files/a.txt", body, { contentType: "text/plain" });

    assert.equal(put.size, body.byteLength);
    assert.equal(put.sha256, crypto.createHash("sha256").update(body).digest("hex"));

    const head = await driver.head("channels/c1/files/a.txt");
    assert.ok(head);
    assert.equal(head!.size, body.byteLength);
    assert.equal(head!.contentType, "text/plain");
    assert.equal(head!.sha256, put.sha256);

    const got = await driver.get("channels/c1/files/a.txt");
    const fetched = await readAll(got.body);
    assert.equal(fetched.toString(), "hello world");
    assert.equal(got.contentType, "text/plain");

    await driver.delete("channels/c1/files/a.txt");
    assert.equal(await driver.head("channels/c1/files/a.txt"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LocalStorageDriver: put hashes streaming bodies correctly", async () => {
  const root = await freshRoot();
  try {
    const driver = new LocalStorageDriver({ rootDir: root });
    const payload = crypto.randomBytes(64 * 1024);
    const expectedSha = crypto.createHash("sha256").update(payload).digest("hex");

    const stream = Readable.from([payload.subarray(0, 16384), payload.subarray(16384)]);
    const put = await driver.put("channels/c1/files/big.bin", stream);
    assert.equal(put.size, payload.byteLength);
    assert.equal(put.sha256, expectedSha);

    const got = await driver.get("channels/c1/files/big.bin");
    const fetched = await readAll(got.body);
    assert.equal(fetched.byteLength, payload.byteLength);
    assert.deepEqual(fetched, payload);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LocalStorageDriver: get on missing key throws StorageNotFound", async () => {
  const root = await freshRoot();
  try {
    const driver = new LocalStorageDriver({ rootDir: root });
    await assert.rejects(() => driver.get("missing/key"), (e: unknown) => e instanceof StorageNotFound);
    assert.equal(await driver.head("missing/key"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LocalStorageDriver: rejects path-traversal keys", async () => {
  const root = await freshRoot();
  try {
    const driver = new LocalStorageDriver({ rootDir: root });
    await assert.rejects(() => driver.put("../escape.txt", Buffer.from("x")));
    await assert.rejects(() => driver.put("/abs.txt", Buffer.from("x")));
    await assert.rejects(() => driver.put("a/../b.txt", Buffer.from("x")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LocalStorageDriver: delete is idempotent", async () => {
  const root = await freshRoot();
  try {
    const driver = new LocalStorageDriver({ rootDir: root });
    await driver.delete("nope/never/created"); // must not throw
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LocalStorageDriver: signedDownloadUrl returns null (no real signing)", async () => {
  const root = await freshRoot();
  try {
    const driver = new LocalStorageDriver({ rootDir: root });
    await driver.put("a/b.txt", Buffer.from("hi"));
    const url = await driver.signedDownloadUrl("a/b.txt", { ttlSeconds: 60 });
    assert.equal(url, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

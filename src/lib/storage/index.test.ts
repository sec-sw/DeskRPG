// src/lib/storage/index.test.ts — factory + key helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  attachmentKey,
  thumbnailKey,
  getStorage,
  resetStorageForTests,
} from "./index";
import { LocalStorageDriver } from "./local-driver";

test("attachmentKey: stable POSIX layout", () => {
  assert.equal(
    attachmentKey("ch1", "att1", "pdf"),
    "channels/ch1/files/att1.pdf",
  );
  assert.equal(
    attachmentKey("ch1", "att1", ".PDF"),
    "channels/ch1/files/att1.pdf",
  );
  assert.equal(
    attachmentKey("ch1", "att1", ""),
    "channels/ch1/files/att1",
  );
});

test("attachmentKey: rejects extension injection attempts", () => {
  // Slashes / backslashes / null bytes get stripped, leaving a safe extension.
  assert.equal(
    attachmentKey("ch1", "att1", "pdf/../etc"),
    "channels/ch1/files/att1.pdfetc",
  );
});

test("thumbnailKey: webp under thumbs/", () => {
  assert.equal(thumbnailKey("ch1", "att1"), "channels/ch1/thumbs/att1.webp");
});

test("getStorage: defaults to LocalStorageDriver when no env set", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-storage-factory-"));
  const prevDriver = process.env.STORAGE_DRIVER;
  const prevDir = process.env.STORAGE_LOCAL_DIR;
  try {
    delete process.env.STORAGE_DRIVER;
    process.env.STORAGE_LOCAL_DIR = tmp;
    resetStorageForTests();
    const driver = getStorage();
    assert.ok(driver instanceof LocalStorageDriver);
    assert.equal(driver.name, "local");
  } finally {
    if (prevDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = prevDriver;
    if (prevDir === undefined) delete process.env.STORAGE_LOCAL_DIR;
    else process.env.STORAGE_LOCAL_DIR = prevDir;
    resetStorageForTests();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("getStorage: throws when STORAGE_DRIVER=s3 but creds missing", () => {
  const prev = { ...process.env };
  try {
    process.env.STORAGE_DRIVER = "s3";
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    resetStorageForTests();
    assert.throws(() => getStorage(), /Missing env var/);
  } finally {
    process.env = prev;
    resetStorageForTests();
  }
});

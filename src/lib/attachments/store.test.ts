// src/lib/attachments/store.test.ts
//
// Integration test: real SQLite (in-memory file path), real LocalStorageDriver
// pointed at a tempdir. Exercises createAttachment quota + size enforcement,
// listChannelAttachments ordering, getChannelStorageBytes accounting, and
// softDeleteAttachment cleanup.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

let tmpHome: string;
let tmpStorage: string;
let tmpSqlite: string;

before(async () => {
  // Set env before any module import that might initialize the DB / storage.
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-attach-test-home-"));
  tmpStorage = await fs.mkdtemp(path.join(os.tmpdir(), "deskrpg-attach-test-store-"));
  tmpSqlite = path.join(tmpHome, "test.db");

  process.env.DESKRPG_HOME = tmpHome;
  process.env.DB_TYPE = "sqlite";
  process.env.SQLITE_PATH = tmpSqlite;
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = tmpStorage;
  // Tight per-channel quota so we can exercise it cheaply.
  process.env.STORAGE_CHANNEL_QUOTA_BYTES = "10000";
  process.env.STORAGE_FILE_MAX_BYTES = "5000";
});

after(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(tmpStorage, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.STORAGE_CHANNEL_QUOTA_BYTES;
  delete process.env.STORAGE_FILE_MAX_BYTES;
});

const TEST_USER_ID = randomUUID();
const TEST_CHANNEL_ID = randomUUID();

async function seed() {
  const { db } = await import("@/db");
  // Seed minimum schema: a user and a channel referencing the user.
  // Using parameterized SQL via Drizzle's execute() requires a sql literal —
  // simpler to use raw better-sqlite3 via the underlying client.
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(tmpSqlite);
  sqlite.exec(`
    INSERT OR IGNORE INTO users (id, login_id, nickname, password_hash, system_role)
    VALUES ('${TEST_USER_ID}', 'tester', 'Tester', 'x', 'user');
    INSERT OR IGNORE INTO channels (id, name, owner_id, is_public, max_players, created_at, updated_at)
    VALUES ('${TEST_CHANNEL_ID}', 'Test', '${TEST_USER_ID}', 1, 50, '${new Date().toISOString()}', '${new Date().toISOString()}');
  `);
  sqlite.close();
  // Force the singleton to materialize so it sees the seeded rows.
  void (db as unknown as { __unused?: never });
}

async function clearAttachments() {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(tmpSqlite);
  sqlite.exec("DELETE FROM attachments");
  sqlite.close();
}

test("createAttachment: happy path writes bytes + row", async () => {
  await seed();
  const { createAttachment, getChannelStorageBytes, listChannelAttachments } = await import(
    "./store"
  );
  await clearAttachments();

  const result = await createAttachment({
    channelId: TEST_CHANNEL_ID,
    uploaderId: TEST_USER_ID,
    filename: "hello.txt",
    contentType: "text/plain",
    body: Buffer.from("hello world"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected ok");
  assert.equal(result.attachment.byteSize, 11);
  assert.equal(result.attachment.filename, "hello.txt");
  assert.equal(result.attachment.contentType, "text/plain");
  assert.match(result.attachment.sha256, /^[0-9a-f]{64}$/);

  const total = await getChannelStorageBytes(TEST_CHANNEL_ID);
  assert.equal(total, 11);

  const list = await listChannelAttachments(TEST_CHANNEL_ID);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, result.attachment.id);
});

test("createAttachment: rejects single file over per-file cap", async () => {
  await seed();
  const { createAttachment } = await import("./store");
  await clearAttachments();

  const oversized = Buffer.alloc(5001, 0x61); // STORAGE_FILE_MAX_BYTES is 5000
  const result = await createAttachment({
    channelId: TEST_CHANNEL_ID,
    uploaderId: TEST_USER_ID,
    filename: "big.bin",
    contentType: "application/octet-stream",
    body: oversized,
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.equal(result.errorCode, "attachment_file_too_large");
});

test("createAttachment: rejects upload that would exceed channel quota", async () => {
  await seed();
  const { createAttachment, getChannelStorageBytes } = await import("./store");
  await clearAttachments();

  // Two 4 KB blobs fit (8 KB), the third 3 KB blob would push to 11 KB > 10 KB.
  const blob = Buffer.alloc(4000, 0x61);
  for (let i = 0; i < 2; i++) {
    const r = await createAttachment({
      channelId: TEST_CHANNEL_ID,
      uploaderId: TEST_USER_ID,
      filename: `f${i}.bin`,
      contentType: "application/octet-stream",
      body: blob,
    });
    assert.equal(r.ok, true);
  }

  const overflow = await createAttachment({
    channelId: TEST_CHANNEL_ID,
    uploaderId: TEST_USER_ID,
    filename: "overflow.bin",
    contentType: "application/octet-stream",
    body: Buffer.alloc(3000, 0x62),
  });
  assert.equal(overflow.ok, false);
  if (overflow.ok) throw new Error("expected quota failure");
  assert.equal(overflow.errorCode, "channel_quota_exceeded");

  const total = await getChannelStorageBytes(TEST_CHANNEL_ID);
  assert.equal(total, 8000);
});

test("softDeleteAttachment: removes from listing and frees quota space", async () => {
  await seed();
  const { createAttachment, listChannelAttachments, softDeleteAttachment, getChannelStorageBytes } =
    await import("./store");
  await clearAttachments();

  const r = await createAttachment({
    channelId: TEST_CHANNEL_ID,
    uploaderId: TEST_USER_ID,
    filename: "deleteme.txt",
    contentType: "text/plain",
    body: Buffer.from("xxx"),
  });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error();

  assert.equal((await listChannelAttachments(TEST_CHANNEL_ID)).length, 1);
  assert.equal(await getChannelStorageBytes(TEST_CHANNEL_ID), 3);

  const ok = await softDeleteAttachment(r.attachment.id);
  assert.equal(ok, true);

  assert.equal((await listChannelAttachments(TEST_CHANNEL_ID)).length, 0);
  assert.equal(await getChannelStorageBytes(TEST_CHANNEL_ID), 0);

  // Idempotent: a second delete is a no-op.
  assert.equal(await softDeleteAttachment(r.attachment.id), false);
});

test("listChannelAttachments: orders by createdAt descending", async () => {
  await seed();
  const { createAttachment, listChannelAttachments } = await import("./store");
  await clearAttachments();

  const a = await createAttachment({
    channelId: TEST_CHANNEL_ID,
    uploaderId: TEST_USER_ID,
    filename: "first.txt",
    contentType: "text/plain",
    body: Buffer.from("1"),
  });
  // Tiny pause so created_at ordering is stable across SQLite millisecond resolution.
  await new Promise((r) => setTimeout(r, 5));
  const b = await createAttachment({
    channelId: TEST_CHANNEL_ID,
    uploaderId: TEST_USER_ID,
    filename: "second.txt",
    contentType: "text/plain",
    body: Buffer.from("2"),
  });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) throw new Error();

  const list = await listChannelAttachments(TEST_CHANNEL_ID);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.attachment.id);
  assert.equal(list[1].id, a.attachment.id);
});

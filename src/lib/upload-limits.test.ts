import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ATTACHMENT_FILE_MAX_BYTES,
  DEFAULT_CHANNEL_QUOTA_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_TOTAL_BYTES,
  MAX_AUXILIARY_UPLOAD_BYTES,
  MAX_MAIN_UPLOAD_BYTES,
  consumeArchiveEntry,
  getAttachmentFileMaxBytes,
  getChannelQuotaBytes,
  validateAttachmentFileSize,
  validateAuxiliaryUploadSize,
  validateChannelQuota,
  validateMainUploadSize,
} from "./upload-limits";

test("main upload size rejects oversized payloads", () => {
  assert.equal(validateMainUploadSize(MAX_MAIN_UPLOAD_BYTES), null);
  assert.equal(validateMainUploadSize(MAX_MAIN_UPLOAD_BYTES + 1), "upload_file_too_large");
});

test("auxiliary upload size rejects oversized image payloads", () => {
  assert.equal(validateAuxiliaryUploadSize(MAX_AUXILIARY_UPLOAD_BYTES), null);
  assert.equal(validateAuxiliaryUploadSize(MAX_AUXILIARY_UPLOAD_BYTES + 1), "upload_file_too_large");
});

test("archive budget rejects too many entries", () => {
  let budget = { entries: 0, totalBytes: 0 };
  for (let i = 0; i < MAX_ARCHIVE_ENTRIES; i += 1) {
    const result = consumeArchiveEntry(budget, 1024);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected archive entry to be accepted");
    budget = result.budget;
  }

  const overflow = consumeArchiveEntry(budget, 1024);
  assert.equal(overflow.ok, false);
  if (overflow.ok) throw new Error("expected archive entry overflow");
  assert.equal(overflow.errorCode, "upload_archive_too_many_entries");
});

test("archive budget rejects total extracted bytes above limit", () => {
  const result = consumeArchiveEntry(
    { entries: 1, totalBytes: MAX_ARCHIVE_TOTAL_BYTES - 64 },
    128,
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected total bytes overflow");
  assert.equal(result.errorCode, "upload_archive_too_large");
});

test("attachment file size: defaults to 100 MiB and is env-overridable", () => {
  const prev = process.env.STORAGE_FILE_MAX_BYTES;
  try {
    delete process.env.STORAGE_FILE_MAX_BYTES;
    assert.equal(getAttachmentFileMaxBytes(), DEFAULT_ATTACHMENT_FILE_MAX_BYTES);
    assert.equal(validateAttachmentFileSize(DEFAULT_ATTACHMENT_FILE_MAX_BYTES), null);
    assert.equal(
      validateAttachmentFileSize(DEFAULT_ATTACHMENT_FILE_MAX_BYTES + 1),
      "attachment_file_too_large",
    );

    process.env.STORAGE_FILE_MAX_BYTES = "1024";
    assert.equal(getAttachmentFileMaxBytes(), 1024);
    assert.equal(validateAttachmentFileSize(1025), "attachment_file_too_large");

    // Invalid env values fall back to default rather than disabling the limit silently.
    process.env.STORAGE_FILE_MAX_BYTES = "garbage";
    assert.equal(getAttachmentFileMaxBytes(), DEFAULT_ATTACHMENT_FILE_MAX_BYTES);
  } finally {
    if (prev === undefined) delete process.env.STORAGE_FILE_MAX_BYTES;
    else process.env.STORAGE_FILE_MAX_BYTES = prev;
  }
});

test("channel quota: 0 disables the cap, otherwise compares current+incoming", () => {
  const prev = process.env.STORAGE_CHANNEL_QUOTA_BYTES;
  try {
    delete process.env.STORAGE_CHANNEL_QUOTA_BYTES;
    assert.equal(getChannelQuotaBytes(), DEFAULT_CHANNEL_QUOTA_BYTES);

    assert.equal(validateChannelQuota(0, 1024), null);
    assert.equal(
      validateChannelQuota(DEFAULT_CHANNEL_QUOTA_BYTES, 1),
      "channel_quota_exceeded",
    );

    process.env.STORAGE_CHANNEL_QUOTA_BYTES = "0";
    assert.equal(validateChannelQuota(Number.MAX_SAFE_INTEGER, 1), null);

    process.env.STORAGE_CHANNEL_QUOTA_BYTES = "1000";
    assert.equal(validateChannelQuota(900, 100), null);
    assert.equal(validateChannelQuota(900, 101), "channel_quota_exceeded");
  } finally {
    if (prev === undefined) delete process.env.STORAGE_CHANNEL_QUOTA_BYTES;
    else process.env.STORAGE_CHANNEL_QUOTA_BYTES = prev;
  }
});

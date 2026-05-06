// src/lib/attachments/thumbnail.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { isThumbnailable } from "./thumbnail";

test("isThumbnailable: matches common image MIMEs", () => {
  assert.equal(isThumbnailable("image/png"), true);
  assert.equal(isThumbnailable("image/jpeg"), true);
  assert.equal(isThumbnailable("image/webp"), true);
  assert.equal(isThumbnailable("image/gif"), true);
});

test("isThumbnailable: rejects non-images", () => {
  assert.equal(isThumbnailable("application/pdf"), false);
  assert.equal(isThumbnailable("text/plain"), false);
  assert.equal(isThumbnailable("video/mp4"), false);
});

test("isThumbnailable: case-insensitive", () => {
  assert.equal(isThumbnailable("IMAGE/PNG"), true);
  assert.equal(isThumbnailable("Image/Webp"), true);
});

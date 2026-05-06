// src/lib/attachments/access.test.ts — pure-function RBAC tests.
import test from "node:test";
import assert from "node:assert/strict";

import { canDeleteAttachment } from "./access";
import type { ChannelAccessSummary } from "./access";

function ctx(overrides: Partial<ChannelAccessSummary> = {}): ChannelAccessSummary {
  return {
    channelId: "ch1",
    ownerId: "owner",
    groupId: null,
    isPublic: true,
    isOwner: false,
    isChannelMember: true,
    hasActiveGroupMembership: false,
    systemRole: "user",
    ...overrides,
  };
}

test("canDeleteAttachment: original uploader can always delete their own", () => {
  assert.equal(canDeleteAttachment(ctx(), "uploader-x", "uploader-x"), true);
});

test("canDeleteAttachment: channel owner can delete anyone's attachment", () => {
  const c = ctx({ isOwner: true });
  assert.equal(canDeleteAttachment(c, "someone-else", "owner"), true);
});

test("canDeleteAttachment: system_admin overrides everything", () => {
  const c = ctx({ systemRole: "system_admin" });
  assert.equal(canDeleteAttachment(c, "someone-else", "admin-user"), true);
});

test("canDeleteAttachment: regular member cannot delete others' attachments", () => {
  const c = ctx({ isOwner: false, systemRole: "user" });
  assert.equal(canDeleteAttachment(c, "someone-else", "regular-member"), false);
});

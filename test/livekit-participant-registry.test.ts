import assert from "node:assert/strict";
import test from "node:test";

import {
  LiveKitParticipantRegistry,
  userIdFromParticipantIdentity
} from "../src/livekit/livekit-participant-registry.js";

const USER_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const USER_B = "4dd5adca-71ba-4204-a91f-e50b29bb83b9";

test("extracts a UUID from a BE-issued user identity", () => {
  assert.equal(userIdFromParticipantIdentity(`user-${USER_A}`), USER_A);
});

test("ignores guest, server, and malformed identities", () => {
  assert.equal(userIdFromParticipantIdentity("guest-123"), undefined);
  assert.equal(userIdFromParticipantIdentity("meetbowl-stt-session"), undefined);
  assert.equal(userIdFromParticipantIdentity("user-not-a-uuid"), undefined);
});

test("tracks current authenticated users and returns a stable snapshot", () => {
  const registry = new LiveKitParticipantRegistry();

  assert.equal(registry.add(`user-${USER_B}`), true);
  assert.equal(registry.add("guest-123"), false);
  assert.equal(registry.add(`user-${USER_A}`), true);
  assert.deepEqual(registry.snapshotUserIds(), [USER_A, USER_B]);
  assert.deepEqual(
    registry.identitiesForUserIds([USER_B, USER_A, USER_B]),
    [`user-${USER_A}`, `user-${USER_B}`]
  );
  assert.deepEqual(registry.identitiesForUserIds(["5bb1ad5e-a202-4ef3-9218-570724f25225"]), []);

  registry.remove(`user-${USER_A}`);
  assert.deepEqual(registry.snapshotUserIds(), [USER_B]);

  registry.clear();
  assert.deepEqual(registry.snapshotUserIds(), []);
});

test("replace rebuilds the registry from current room identities and drops stale users", () => {
  const registry = new LiveKitParticipantRegistry();
  registry.add(`user-${USER_A}`);

  const summary = registry.replace([
    `user-${USER_B}`,
    "guest-123",
    "meetbowl-stt-session"
  ]);

  assert.deepEqual(summary, {
    roomParticipantCount: 3,
    authenticatedParticipantCount: 1,
    ignoredParticipantCount: 2,
    addedCount: 1,
    removedCount: 1,
    replacedCount: 0
  });
  assert.deepEqual(registry.snapshotUserIds(), [USER_B]);
});

test("replace keeps the same snapshot stable across reconnect-style resync", () => {
  const registry = new LiveKitParticipantRegistry();
  registry.add(`user-${USER_A}`);
  registry.add(`user-${USER_B}`);

  const summary = registry.replace([`user-${USER_A}`, `user-${USER_B}`]);

  assert.deepEqual(summary, {
    roomParticipantCount: 2,
    authenticatedParticipantCount: 2,
    ignoredParticipantCount: 0,
    addedCount: 0,
    removedCount: 0,
    replacedCount: 0
  });
  assert.deepEqual(registry.identitiesForUserIds([USER_A, USER_B]), [
    `user-${USER_A}`,
    `user-${USER_B}`
  ]);
});

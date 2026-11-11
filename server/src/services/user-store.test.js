import test from "node:test";
import assert from "node:assert/strict";
import { publicUser } from "./user-store.js";

function userWithPlan(plan) {
  return {
    id: `user-${plan}`,
    email: `${plan}@example.com`,
    displayName: plan,
    role: "user",
    approvalStatus: "approved",
    membership: {
      status: "active",
      plan,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("public pro and team memberships use the 30-item quota defaults", () => {
  const proMembership = publicUser(userWithPlan("pro")).membership;
  const teamMembership = publicUser(userWithPlan("team")).membership;

  assert.equal(proMembership.workflowLimit, 30);
  assert.equal(proMembership.assetLimitPerType, 30);
  assert.equal(proMembership.concurrentJobs, 5);
  assert.equal(teamMembership.workflowLimit, 30);
  assert.equal(teamMembership.assetLimitPerType, 30);
  assert.equal(teamMembership.concurrentJobs, 5);
  assert.equal(teamMembership.teamSeatLimit, 5);
});

test("public basic memberships keep the existing 10-item quota defaults", () => {
  const membership = publicUser(userWithPlan("basic")).membership;

  assert.equal(membership.workflowLimit, 10);
  assert.equal(membership.assetLimitPerType, 10);
  assert.equal(membership.concurrentJobs, 2);
});

import test from "node:test";
import assert from "node:assert/strict";
import { membershipPlanDefaults, membershipPlans } from "./membership-plans.mjs";
import { membershipPlans as serverMembershipPlans } from "../server/src/lib/membership-plans.mjs";

test("membership plan quotas match the current package limits", () => {
  assert.deepEqual(membershipPlanDefaults("basic"), {
    name: "基础版",
    workflowLimit: 10,
    concurrentJobs: 2,
    assetLimitPerType: 10,
    teamSeatLimit: 1,
  });
  assert.equal(membershipPlans.pro.workflowLimit, 30);
  assert.equal(membershipPlans.pro.assetLimitPerType, 30);
  assert.equal(membershipPlans.team.workflowLimit, 30);
  assert.equal(membershipPlans.team.assetLimitPerType, 30);
  assert.deepEqual(serverMembershipPlans, membershipPlans);
});

test("unknown membership plans use the basic defaults", () => {
  assert.equal(membershipPlanDefaults("unknown"), membershipPlans.basic);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  isMembershipQuotaError,
  membershipQuotaErrorCode,
  membershipQuotaResource,
} from "./membership-quota.mjs";

test("membership quota errors are recognized from API details", () => {
  const workflowError = {
    payload: {
      detail: {
        code: "WORKFLOW_LIMIT_REACHED",
      },
    },
  };
  const assetError = {
    detail: {
      code: "ASSET_LIMIT_REACHED",
    },
  };

  assert.equal(isMembershipQuotaError(workflowError), true);
  assert.equal(membershipQuotaErrorCode(assetError), "ASSET_LIMIT_REACHED");
  assert.equal(membershipQuotaResource(workflowError), "workflow");
  assert.equal(membershipQuotaResource(assetError), "asset");
  assert.equal(membershipQuotaResource({ message: "当前会员最多可保存 30 条工作流。" }), "workflow");
});

test("unrelated API errors do not trigger the membership quota dialog", () => {
  assert.equal(isMembershipQuotaError({ detail: { code: "TEAM_RESOURCE_UNAVAILABLE" } }), false);
  assert.equal(isMembershipQuotaError({ message: "网络连接失败。" }), false);
});

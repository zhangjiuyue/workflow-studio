export const MEMBERSHIP_QUOTA_REACHED_EVENT = "flowstudio-membership-quota-reached";

const MEMBERSHIP_QUOTA_ERROR_CODES = new Set([
  "WORKFLOW_LIMIT_REACHED",
  "ASSET_LIMIT_REACHED",
]);

export function membershipQuotaErrorCode(error = {}) {
  return String(
    error.code
    || error.detail?.code
    || error.payload?.detail?.code
    || error.payload?.code
    || "",
  ).trim();
}

export function isMembershipQuotaError(error = {}) {
  const code = membershipQuotaErrorCode(error);
  if (MEMBERSHIP_QUOTA_ERROR_CODES.has(code)) return true;
  return /最多可保存\s*\d+\s*条工作流|每类创意资产最多可保存\s*\d+\s*个/.test(String(error.message || ""));
}

export function membershipQuotaResource(error = {}) {
  if (membershipQuotaErrorCode(error) === "WORKFLOW_LIMIT_REACHED") return "workflow";
  return /工作流/.test(String(error.message || "")) ? "workflow" : "asset";
}

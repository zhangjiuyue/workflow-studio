export const membershipPlans = Object.freeze({
  basic: Object.freeze({
    name: "基础版",
    workflowLimit: 10,
    concurrentJobs: 2,
    assetLimitPerType: 10,
    teamSeatLimit: 1,
  }),
  pro: Object.freeze({
    name: "高级版",
    workflowLimit: 30,
    concurrentJobs: 5,
    assetLimitPerType: 30,
    teamSeatLimit: 1,
  }),
  team: Object.freeze({
    name: "团队版",
    workflowLimit: 30,
    concurrentJobs: 5,
    assetLimitPerType: 30,
    teamSeatLimit: 5,
  }),
});

export function membershipPlanDefaults(plan) {
  return membershipPlans[plan] || membershipPlans.basic;
}

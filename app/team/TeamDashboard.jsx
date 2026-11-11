"use client";

import { useEffect, useMemo, useState } from "react";
import PageLoading from "../../components/PageLoading";
import { useLanguage } from "../../components/LanguageProvider";
import {
  approveTeamAsset,
  createTeam,
  getTeamContext,
  joinTeam,
  leaveTeam,
  listTeamReviewAssets,
  readAuthToken,
  removeTeamMember,
  rejectTeamAsset,
} from "../../lib/flowstudio-api";

const emptyContext = { team: null, role: "none" };

const teamText = {
  loadingInfo: { zh: "正在读取团队信息...", en: "Loading team information..." },
  synced: { zh: "团队信息已同步。", en: "Team information synced." },
  notJoinedMessage: { zh: "你还没有加入团队。", en: "You have not joined a team yet." },
  loadFailed: { zh: "团队信息读取失败。", en: "Unable to load team information." },
  creating: { zh: "正在创建团队...", en: "Creating team..." },
  defaultTeamName: { zh: "我的团队", en: "My team" },
  teamCreated: { zh: "团队已创建。", en: "Team created." },
  createFailed: { zh: "团队创建失败。", en: "Unable to create team." },
  upgradePrompt: {
    zh: "标准版和高级版可通过邀请码加入团队；创建团队需要先升级为团队版套餐。",
    en: "Basic and Pro members can join with an invite code. Creating a team requires the Team plan.",
  },
  joining: { zh: "正在加入团队...", en: "Joining team..." },
  joined: { zh: "已加入团队。", en: "Joined team." },
  joinFailed: { zh: "加入团队失败。", en: "Unable to join team." },
  leaveTitle: { zh: "离开团队", en: "Leave team" },
  leaveSummary: {
    zh: "离开后，你将无法继续使用团队共享的 API Key 和创意资产。",
    en: "After leaving, you will no longer be able to use team-shared API keys and creative assets.",
  },
  leaveDetail: {
    zh: "引用团队资源的工作流历史结果仍可查看，但不能重新运行。",
    en: "Workflow history that references team resources remains visible, but cannot be rerun.",
  },
  removeTitle: { zh: "移除成员", en: "Remove member" },
  removeSummaryPrefix: { zh: "确定将", en: "Remove" },
  removeSummarySuffix: { zh: "移出团队吗？", en: "from this team?" },
  removeDetail: { zh: "移除后，该成员将无法继续使用团队共享资源。", en: "After removal, this member cannot use team-shared resources." },
  removed: { zh: "成员已移除。", en: "Member removed." },
  removeFailed: { zh: "移除成员失败。", en: "Unable to remove member." },
  left: { zh: "已离开团队。", en: "Left team." },
  leaveFailed: { zh: "离开团队失败。", en: "Unable to leave team." },
  shared: { zh: "资产已共享给团队。", en: "Asset shared with the team." },
  rejected: { zh: "已拒绝共享申请。", en: "Share request rejected." },
  reviewFailed: { zh: "审核操作失败。", en: "Unable to complete review action." },
  loadingManage: { zh: "正在读取团队管理", en: "Loading team management" },
  notJoinedTitle: { zh: "你还没有加入团队", en: "You are not in a team yet" },
  teamValue: {
    zh: "团队版可共享 API Key、角色、脚本、文风和图风等创意资产。",
    en: "Team plans can share API keys, roles, scripts, writing styles, visual styles, and other creative assets.",
  },
  joinTeam: { zh: "加入团队", en: "Join team" },
  inviteCode: { zh: "邀请码", en: "Invite code" },
  invitePlaceholder: { zh: "输入团队邀请码", en: "Enter team invite code" },
  joiningShort: { zh: "加入中", en: "Joining" },
  createTeam: { zh: "创建团队", en: "Create team" },
  teamName: { zh: "团队名称", en: "Team name" },
  teamNamePlaceholder: { zh: "例如：示例内容工作室", en: "Example: Example Content Studio" },
  creatingShort: { zh: "创建中", en: "Creating" },
  createTeamUpgrade: { zh: "升级团队版后创建", en: "Upgrade to Team to create" },
  ownerDescription: { zh: "管理团队席位、邀请码、成员和待审核共享资产。", en: "Manage seats, invite codes, members, and pending shared assets." },
  memberDescription: { zh: "你已加入该团队，可使用团队共享资源。", en: "You have joined this team and can use shared resources." },
  seats: { zh: "席位", en: "Seats" },
  myRole: { zh: "我的角色：", en: "My role:" },
  owner: { zh: "所有者", en: "Owner" },
  member: { zh: "成员", en: "Member" },
  teamOwner: { zh: "团队所有者：", en: "Team owner:" },
  inviteVisible: { zh: "邀请码：", en: "Invite code:" },
  ownerOnly: { zh: "仅所有者可见", en: "Owner only" },
  members: { zh: "团队成员", en: "Team members" },
  people: { zh: "人", en: "people" },
  role: { zh: "身份：", en: "Role:" },
  joinedAt: { zh: "加入：", en: "Joined:" },
  removing: { zh: "移除中", en: "Removing" },
  remove: { zh: "移除", en: "Remove" },
  shareReview: { zh: "共享审核", en: "Share review" },
  pendingCountSuffix: { zh: "个待审核", en: "pending" },
  unnamedAsset: { zh: "未命名资产", en: "Unnamed asset" },
  submitterFallback: { zh: "成员", en: "Member" },
  noSummary: { zh: "暂无摘要", en: "No summary" },
  reject: { zh: "拒绝", en: "Reject" },
  approve: { zh: "通过共享", en: "Approve share" },
  noReviews: { zh: "暂无待审核资产。", en: "No assets pending review." },
  teamStatus: { zh: "团队状态", en: "Team status" },
  joinedStatus: { zh: "已加入", en: "Joined" },
  memberNote: {
    zh: "你可以使用团队共享的 API Key 和创意资产；离开后，引用团队资源的工作流将无法重新运行。",
    en: "You can use team-shared API keys and creative assets. After leaving, workflows that reference team resources cannot be rerun.",
  },
  processing: { zh: "处理中", en: "Processing" },
  confirmEyebrow: { zh: "确认操作", en: "Confirm action" },
  cancel: { zh: "取消", en: "Cancel" },
  confirm: { zh: "确认", en: "Confirm" },
  unknownTime: { zh: "时间未知", en: "Unknown time" },
  assetTypes: {
    "writing-style": { zh: "文风", en: "Writing style" },
    prompt: { zh: "提示词", en: "Prompt" },
    "visual-style": { zh: "图风", en: "Visual style" },
    script: { zh: "脚本", en: "Script" },
    role: { zh: "角色", en: "Role" },
    hook: { zh: "开头", en: "Hook" },
    element: { zh: "元素", en: "Element" },
    product: { zh: "产品", en: "Product" },
    fallback: { zh: "资产", en: "Asset" },
  },
};

export default function TeamDashboard() {
  const { language, t } = useLanguage();
  const [context, setContext] = useState(emptyContext);
  const [reviews, setReviews] = useState([]);
  const [teamName, setTeamName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loadState, setLoadState] = useState("loading");
  const [message, setMessage] = useState("正在读取团队信息...");
  const [initialLoading, setInitialLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [confirmDialog, setConfirmDialog] = useState(null);

  const team = context.team;
  const isOwner = context.role === "owner";
  const members = useMemo(() => Array.isArray(team?.members) ? team.members : [], [team]);
  const canCreateTeam = Boolean(context.canCreateTeam || context.membershipPlan === "team");

  useEffect(() => {
    if (!readAuthToken()) return;
    let active = true;
    loadTeam(() => active);
    return () => {
      active = false;
    };
  }, []);

  async function loadTeam(isActive = () => true, options = {}) {
    if (!options.silent) {
      setLoadState("loading");
      setMessage(t(teamText.loadingInfo));
    }
    try {
      const result = await getTeamContext();
      if (!isActive()) return;
      const nextContext = result || emptyContext;
      setContext(nextContext);
      if (nextContext.role === "owner") {
        const reviewResult = await listTeamReviewAssets().catch(() => ({ assets: [] }));
        if (!isActive()) return;
        setReviews(Array.isArray(reviewResult.assets) ? reviewResult.assets : []);
      } else {
        setReviews([]);
      }
      setLoadState("ready");
      setMessage(nextContext.team ? t(teamText.synced) : t(teamText.notJoinedMessage));
    } catch (error) {
      if (!isActive()) return;
      setLoadState("error");
      setMessage(error.message || t(teamText.loadFailed));
    } finally {
      if (!options.silent && isActive()) setInitialLoading(false);
    }
  }

  async function handleCreateTeam(event) {
    event.preventDefault();
    if (!canCreateTeam) {
      showTeamUpgradePrompt();
      return;
    }
    setBusyAction("create");
    setLoadState("loading");
    setMessage(t(teamText.creating));
    try {
      const result = await createTeam({ name: teamName.trim() || t(teamText.defaultTeamName) });
      setContext(result || emptyContext);
      setTeamName("");
      await loadTeam(() => true, { silent: true });
      setLoadState("ready");
      setMessage(t(teamText.teamCreated));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || t(teamText.createFailed));
    } finally {
      setBusyAction("");
    }
  }

  function showTeamUpgradePrompt() {
    setLoadState("warning");
    setMessage(t(teamText.upgradePrompt));
  }

  async function handleJoinTeam(event) {
    event.preventDefault();
    setBusyAction("join");
    setLoadState("loading");
    setMessage(t(teamText.joining));
    try {
      const result = await joinTeam(inviteCode.trim());
      setContext(result || emptyContext);
      setInviteCode("");
      setLoadState("ready");
      setMessage(t(teamText.joined));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || t(teamText.joinFailed));
    } finally {
      setBusyAction("");
    }
  }

  function requestLeaveTeam() {
    setConfirmDialog({
      action: "leave",
      title: t(teamText.leaveTitle),
      summary: t(teamText.leaveSummary),
      detail: t(teamText.leaveDetail),
      confirmText: t(teamText.leaveTitle),
      danger: true,
    });
  }

  async function handleLeaveTeam() {
    setBusyAction("leave");
    setLoadState("loading");
    setMessage(t(teamText.leaveTitle));
    try {
      await leaveTeam();
      setContext(emptyContext);
      setLoadState("ready");
      setMessage(t(teamText.left));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || t(teamText.leaveFailed));
    } finally {
      setBusyAction("");
    }
  }

  function requestRemoveMember(member) {
    const label = member.user?.displayName || member.user?.email || member.userId;
    setConfirmDialog({
      action: "remove",
      member,
      title: t(teamText.removeTitle),
      summary: language === "en"
        ? `${t(teamText.removeSummaryPrefix)} ${label} ${t(teamText.removeSummarySuffix)}`
        : `${t(teamText.removeSummaryPrefix)} ${label} ${t(teamText.removeSummarySuffix)}`,
      detail: t(teamText.removeDetail),
      confirmText: t(teamText.removeTitle),
      danger: true,
    });
  }

  async function handleRemoveMember(member) {
    setBusyAction(`remove-${member.userId}`);
    try {
      const result = await removeTeamMember(member.userId);
      setContext(result || emptyContext);
      setLoadState("ready");
      setMessage(t(teamText.removed));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || t(teamText.removeFailed));
    } finally {
      setBusyAction("");
    }
  }

  async function handleConfirmDialog() {
    const dialog = confirmDialog;
    if (!dialog) return;
    setConfirmDialog(null);
    if (dialog.action === "leave") {
      await handleLeaveTeam();
      return;
    }
    if (dialog.action === "remove" && dialog.member) {
      await handleRemoveMember(dialog.member);
    }
  }

  async function handleReview(asset, decision) {
    setBusyAction(`${decision}-${asset.id}`);
    try {
      if (decision === "approve") await approveTeamAsset(asset.id);
      else await rejectTeamAsset(asset.id);
      setReviews((current) => current.filter((item) => item.id !== asset.id));
      setLoadState("ready");
      setMessage(decision === "approve" ? t(teamText.shared) : t(teamText.rejected));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || t(teamText.reviewFailed));
    } finally {
      setBusyAction("");
    }
  }

  const showInitialLoading = initialLoading && loadState === "loading";

  if (!team) {
    return (
      <section className="team-dashboard-next">
        {showInitialLoading ? (
          <div className="team-empty-next">
            <PageLoading label={t(teamText.loadingManage)} />
          </div>
        ) : (
          <div className="team-empty-next">
            <div>
              <h2>{t(teamText.notJoinedTitle)}</h2>
              <p>{t(teamText.teamValue)}</p>
            </div>
            <div className="team-entry-grid-next">
              <form onSubmit={handleJoinTeam}>
                <h3>{t(teamText.joinTeam)}</h3>
                <label>
                  {t(teamText.inviteCode)}
                  <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder={t(teamText.invitePlaceholder)} />
                </label>
                <button className="primary-action compact" type="submit" disabled={busyAction === "join"}>
                  {busyAction === "join" ? t(teamText.joiningShort) : t(teamText.joinTeam)}
                </button>
              </form>
              {canCreateTeam ? (
                <form onSubmit={handleCreateTeam}>
                  <h3>{t(teamText.createTeam)}</h3>
                  <label>
                    {t(teamText.teamName)}
                    <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder={t(teamText.teamNamePlaceholder)} />
                  </label>
                  <button className="secondary-action compact" type="submit" disabled={busyAction === "create"}>
                    {busyAction === "create" ? t(teamText.creatingShort) : t(teamText.createTeam)}
                  </button>
                </form>
              ) : (
                <article className="team-upgrade-card-next">
                  <h3>{t(teamText.createTeam)}</h3>
                  <p>{t(teamText.upgradePrompt)}</p>
                  <button className="secondary-action compact" type="button" onClick={showTeamUpgradePrompt}>
                    {t(teamText.createTeamUpgrade)}
                  </button>
                </article>
              )}
            </div>
          </div>
        )}
        <p className={`team-sync-message-next ${loadState}`}>{message}</p>
      </section>
    );
  }

  return (
    <section className="team-dashboard-next">
      <div className="team-panel-next">
        <div className="team-panel-head-next">
          <div>
            <h2>{team.name}</h2>
            <p>{isOwner ? t(teamText.ownerDescription) : t(teamText.memberDescription)}</p>
          </div>
          <div className="team-seat-meter-next">
            <strong>{Number(team.seatUsed || 0)}/{Number(team.seatLimit || 0)}</strong>
            <span>{t(teamText.seats)}</span>
          </div>
        </div>

        <section className="team-info-grid-next">
          <article>
            <span>{t(teamText.myRole)}</span>
            <strong>{isOwner ? t(teamText.owner) : t(teamText.member)}</strong>
          </article>
          <article>
            <span>{t(teamText.teamOwner)}</span>
            <strong>{team.owner?.displayName || team.owner?.email || team.ownerUserId}</strong>
          </article>
          <article>
            <span>{t(teamText.inviteVisible)}</span>
            <strong>{isOwner ? team.inviteCode : t(teamText.ownerOnly)}</strong>
          </article>
        </section>

        {isOwner ? (
          <>
            <section className="team-section-next">
              <div className="team-section-head-next">
                <h3>{t(teamText.members)}</h3>
                <span>{members.length} {t(teamText.people)}</span>
              </div>
              <div className="team-member-list-next">
                {members.map((member) => (
                  <article key={member.userId}>
                    <div>
                      <strong>{member.user?.displayName || member.user?.email || member.userId}</strong>
                      <span>{t(teamText.role)} {member.role === "owner" ? t(teamText.owner) : t(teamText.member)} · {t(teamText.joinedAt)} {formatDate(member.joinedAt, language)}</span>
                    </div>
                    {member.role !== "owner" ? (
                      <button className="secondary-action compact" type="button" disabled={Boolean(busyAction)} onClick={() => requestRemoveMember(member)}>
                        {busyAction === `remove-${member.userId}` ? t(teamText.removing) : t(teamText.remove)}
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>

            <section className="team-section-next">
              <div className="team-section-head-next">
                <h3>{t(teamText.shareReview)}</h3>
                <span>{reviews.length} {t(teamText.pendingCountSuffix)}</span>
              </div>
              <div className="team-review-list-next">
                {reviews.length ? reviews.map((asset) => (
                  <article key={asset.id}>
                    <div>
                      <strong>{asset.name || t(teamText.unnamedAsset)}</strong>
                      <span>{assetTypeLabel(asset.type, language)} · {asset.submitter?.displayName || asset.submitter?.email || t(teamText.submitterFallback)} · {formatDate(asset.updatedAt, language)}</span>
                    </div>
                    <p>{asset.desc || compactText(asset.prompt, 80) || t(teamText.noSummary)}</p>
                    <div className="team-review-actions-next">
                      <button className="secondary-action compact" type="button" disabled={Boolean(busyAction)} onClick={() => handleReview(asset, "reject")}>
                        {t(teamText.reject)}
                      </button>
                      <button className="primary-action compact" type="button" disabled={Boolean(busyAction)} onClick={() => handleReview(asset, "approve")}>
                        {t(teamText.approve)}
                      </button>
                    </div>
                  </article>
                )) : (
                  <div className="team-empty-row-next">{t(teamText.noReviews)}</div>
                )}
              </div>
            </section>
          </>
        ) : (
          <section className="team-section-next">
            <div className="team-section-head-next">
              <h3>{t(teamText.teamStatus)}</h3>
              <span>{t(teamText.joinedStatus)}</span>
            </div>
            <p className="team-member-note-next">{t(teamText.memberNote)}</p>
            <button className="secondary-action compact" type="button" disabled={busyAction === "leave"} onClick={requestLeaveTeam}>
              {busyAction === "leave" ? t(teamText.processing) : t(teamText.leaveTitle)}
            </button>
          </section>
        )}
      </div>
      <p className={`team-sync-message-next ${loadState}`}>{message}</p>
      {confirmDialog ? (
        <TeamConfirmDialog
          dialog={confirmDialog}
          busy={Boolean(busyAction)}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={handleConfirmDialog}
        />
      ) : null}
    </section>
  );
}

function TeamConfirmDialog({ dialog, busy, onCancel, onConfirm }) {
  const { t } = useLanguage();

  return (
    <div className="team-dialog-backdrop-next" role="presentation" onClick={busy ? undefined : onCancel}>
      <section className={`team-confirm-dialog-next ${dialog.danger ? "danger" : ""}`} role="dialog" aria-modal="true" aria-label={dialog.title} onClick={(event) => event.stopPropagation()}>
        <div>
          <p className="eyebrow">{t(teamText.confirmEyebrow)}</p>
          <h3>{dialog.title}</h3>
          <p>{dialog.summary}</p>
        </div>
        {dialog.detail ? <p className="team-confirm-detail-next">{dialog.detail}</p> : null}
        <div className="team-confirm-actions-next">
          <button className="secondary-action compact" type="button" disabled={busy} onClick={onCancel}>
            {t(teamText.cancel)}
          </button>
          <button className={`primary-action compact ${dialog.danger ? "danger" : ""}`} type="button" disabled={busy} onClick={onConfirm}>
            {busy ? t(teamText.processing) : dialog.confirmText || t(teamText.confirm)}
          </button>
        </div>
      </section>
    </div>
  );
}

function assetTypeLabel(type, language) {
  return {
    "writing-style": teamText.assetTypes["writing-style"],
    prompt: teamText.assetTypes.prompt,
    "visual-style": teamText.assetTypes["visual-style"],
    script: teamText.assetTypes.script,
    role: teamText.assetTypes.role,
    hook: teamText.assetTypes.hook,
    element: teamText.assetTypes.element,
    product: teamText.assetTypes.product,
  }[type]?.[language] || type || teamText.assetTypes.fallback[language];
}

function compactText(value, length) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 3))}...`;
}

function formatDate(value, language) {
  if (!value) return teamText.unknownTime[language];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return teamText.unknownTime[language];
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

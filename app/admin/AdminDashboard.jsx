"use client";

import { useEffect, useMemo, useState } from "react";
import PageLoading from "../../components/PageLoading";
import { membershipPlans } from "../../lib/membership-plans.mjs";
import {
  approveAdminUser,
  getAdminDeploymentCheck,
  getAdminSystemStatus,
  listAdminTeams,
  listAdminAudit,
  listAdminRunLogs,
  listAdminUsers,
  readAuthToken,
  rejectAdminUser,
  updateAdminTeam,
  updateAdminMembership,
} from "../../lib/flowstudio-api";

const adminTabs = [
  { id: "users", label: "用户审批" },
  { id: "teams", label: "团队管理" },
  { id: "runLogs", label: "运行日志" },
  { id: "audit", label: "操作日志" },
  { id: "deploy", label: "上线体检" },
  { id: "system", label: "系统状态" },
];

const emptyRuntimeSummary = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  averageDurationMs: 0,
};

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState("users");
  const [users, setUsers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [runLogs, setRunLogs] = useState([]);
  const [runtimeSummary, setRuntimeSummary] = useState(emptyRuntimeSummary);
  const [auditEvents, setAuditEvents] = useState([]);
  const [deployment, setDeployment] = useState({ counts: {}, checks: [] });
  const [systemStatus, setSystemStatus] = useState(null);
  const [selectedLogUserId, setSelectedLogUserId] = useState("");
  const [selectedTaskType, setSelectedTaskType] = useState("");
  const [selectedLogStatus, setSelectedLogStatus] = useState("");
  const [selectedLogDays, setSelectedLogDays] = useState("7");
  const [selectedAuditUserId, setSelectedAuditUserId] = useState("");
  const [selectedAuditAction, setSelectedAuditAction] = useState("");
  const [loadState, setLoadState] = useState("loading");
  const [message, setMessage] = useState("正在读取后台数据...");
  const [initialLoading, setInitialLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [membershipDialog, setMembershipDialog] = useState(null);

  const metrics = useMemo(() => adminMetrics(users), [users]);
  const activeUserId = selectedLogUserId || users[0]?.id || "";

  useEffect(() => {
    if (!readAuthToken()) return;
    let active = true;
    loadDashboard(() => active);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!users.length || selectedLogUserId) return;
    setSelectedLogUserId(users[0].id);
  }, [selectedLogUserId, users]);

  useEffect(() => {
    if (!readAuthToken() || activeTab !== "runLogs" || !activeUserId) return;
    let active = true;
    loadRunLogs(() => active, { silent: true });
    return () => {
      active = false;
    };
  }, [activeTab, activeUserId, selectedTaskType, selectedLogStatus, selectedLogDays]);

  useEffect(() => {
    if (!readAuthToken() || activeTab !== "audit") return;
    let active = true;
    loadAudit(() => active, { silent: true });
    return () => {
      active = false;
    };
  }, [activeTab, selectedAuditUserId, selectedAuditAction]);

  async function loadDashboard(isActive = () => true, options = {}) {
    if (!options.silent) {
      setLoadState("loading");
      setMessage("正在读取后台数据...");
    }
    try {
      const usersResult = await listAdminUsers();
      if (!isActive()) return;
      const nextUsers = Array.isArray(usersResult.users) ? usersResult.users : [];
      setUsers(nextUsers);
      const defaultUserId = selectedLogUserId || nextUsers[0]?.id || "";
      if (!selectedLogUserId && defaultUserId) setSelectedLogUserId(defaultUserId);

      const [runLogResult, auditResult, deploymentResult, systemResult, teamsResult] = await Promise.allSettled([
        defaultUserId ? listAdminRunLogs({ userId: defaultUserId, taskType: selectedTaskType, status: selectedLogStatus, days: selectedLogDays, limit: 80 }) : Promise.resolve({ events: [], summary: emptyRuntimeSummary }),
        listAdminAudit({ targetUserId: selectedAuditUserId, action: selectedAuditAction, limit: 120 }),
        getAdminDeploymentCheck(),
        getAdminSystemStatus(),
        listAdminTeams(),
      ]);
      if (!isActive()) return;

      if (runLogResult.status === "fulfilled") {
        setRunLogs(Array.isArray(runLogResult.value.events) ? runLogResult.value.events : []);
        setRuntimeSummary(runLogResult.value.summary || emptyRuntimeSummary);
      }
      if (auditResult.status === "fulfilled") {
        setAuditEvents(Array.isArray(auditResult.value.events) ? auditResult.value.events : []);
      }
      if (deploymentResult.status === "fulfilled") {
        setDeployment({
          counts: deploymentResult.value.counts || {},
          checks: Array.isArray(deploymentResult.value.checks) ? deploymentResult.value.checks : [],
        });
      }
      if (systemResult.status === "fulfilled") {
        setSystemStatus(systemResult.value || null);
      }
      if (teamsResult.status === "fulfilled") {
        setTeams(Array.isArray(teamsResult.value.teams) ? teamsResult.value.teams : []);
      }

      const failedParts = [runLogResult, auditResult, deploymentResult, systemResult, teamsResult].filter((result) => result.status === "rejected").length;
      setLoadState(failedParts ? "warning" : "ready");
      setMessage(failedParts ? "用户列表已同步，部分后台模块暂时无法读取。" : "后台数据已同步。");
    } catch (error) {
      if (!isActive()) return;
      setLoadState("error");
      setMessage(error.message || "后台数据读取失败。");
    } finally {
      if (!options.silent && isActive()) setInitialLoading(false);
    }
  }

  async function loadUsers(isActive = () => true) {
    setBusyAction("refresh-users");
    try {
      const result = await listAdminUsers();
      if (!isActive()) return;
      setUsers(Array.isArray(result.users) ? result.users : []);
      setLoadState("ready");
      setMessage("用户审批列表已刷新。");
    } catch (error) {
      if (!isActive()) return;
      setLoadState("error");
      setMessage(error.message || "用户列表读取失败。");
    } finally {
      if (isActive()) setBusyAction("");
    }
  }

  async function loadRunLogs(isActive = () => true, options = {}) {
    const userId = activeUserId;
    if (!userId) {
      setRunLogs([]);
      setRuntimeSummary(emptyRuntimeSummary);
      return;
    }
    if (!options.silent) setBusyAction("refresh-run-logs");
    try {
      const result = await listAdminRunLogs({ userId, taskType: selectedTaskType, status: selectedLogStatus, days: selectedLogDays, limit: 80 });
      if (!isActive()) return;
      setRunLogs(Array.isArray(result.events) ? result.events : []);
      setRuntimeSummary(result.summary || emptyRuntimeSummary);
      if (!options.silent) {
        setLoadState("ready");
        setMessage("运行日志已刷新。");
      } else {
        clearStaleRunLogError();
      }
    } catch (error) {
      if (!isActive()) return;
      setLoadState("error");
      setMessage(error.message || "运行日志读取失败。");
    } finally {
      if (!options.silent && isActive()) setBusyAction("");
    }
  }

  function clearStaleRunLogError() {
    setLoadState((current) => (current === "error" ? "ready" : current));
    setMessage((current) => (isRunLogErrorMessage(current) ? "运行日志已刷新。" : current));
  }

  async function loadAudit(isActive = () => true, options = {}) {
    if (!options.silent) setBusyAction("refresh-audit");
    try {
      const result = await listAdminAudit({ targetUserId: selectedAuditUserId, action: selectedAuditAction, limit: 120 });
      if (!isActive()) return;
      setAuditEvents(Array.isArray(result.events) ? result.events : []);
      if (!options.silent) {
        setLoadState("ready");
        setMessage("操作日志已刷新。");
      }
    } catch (error) {
      if (!isActive()) return;
      setLoadState("error");
      setMessage(error.message || "操作日志读取失败。");
    } finally {
      if (!options.silent && isActive()) setBusyAction("");
    }
  }

  async function loadDeployment(isActive = () => true) {
    setBusyAction("refresh-deploy");
    try {
      const result = await getAdminDeploymentCheck();
      if (!isActive()) return;
      setDeployment({
        counts: result.counts || {},
        checks: Array.isArray(result.checks) ? result.checks : [],
      });
      setLoadState("ready");
      setMessage("上线体检已刷新。");
    } catch (error) {
      if (!isActive()) return;
      setLoadState("error");
      setMessage(error.message || "上线体检读取失败。");
    } finally {
      if (isActive()) setBusyAction("");
    }
  }

  async function loadSystemStatus(isActive = () => true) {
    setBusyAction("refresh-system");
    try {
      const result = await getAdminSystemStatus();
      if (!isActive()) return;
      setSystemStatus(result || null);
      setLoadState("ready");
      setMessage("系统状态已刷新。");
    } catch (error) {
      if (!isActive()) return;
      setLoadState("error");
      setMessage(error.message || "系统状态读取失败。");
    } finally {
      if (isActive()) setBusyAction("");
    }
  }

  async function loadTeams(isActive = () => true) {
    setBusyAction("refresh-teams");
    try {
      const result = await listAdminTeams();
      if (!isActive()) return;
      setTeams(Array.isArray(result.teams) ? result.teams : []);
      setLoadState("ready");
      setMessage("团队列表已刷新。");
    } catch (error) {
      if (!isActive()) return;
      setLoadState("error");
      setMessage(error.message || "团队列表读取失败。");
    } finally {
      if (isActive()) setBusyAction("");
    }
  }

  async function handleUpdateTeam(team, patch) {
    setBusyAction(`team-${team.id}`);
    try {
      await updateAdminTeam(team.id, patch);
      await loadTeams();
      setMessage("团队信息已更新。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "团队信息更新失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleRefreshCurrent() {
    if (busyAction) return;
    if (activeTab === "users") return loadUsers();
    if (activeTab === "teams") return loadTeams();
    if (activeTab === "runLogs") return loadRunLogs();
    if (activeTab === "audit") return loadAudit();
    if (activeTab === "deploy") return loadDeployment();
    if (activeTab === "system") return loadSystemStatus();
    return loadDashboard();
  }

  async function handleApprove(user) {
    setBusyAction(`approve-${user.id}`);
    try {
      await approveAdminUser(user.id, approvalMembershipPayload(user));
      await loadUsers();
      setMessage(`已通过 ${user.displayName || user.email || "用户"}。`);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "审批用户失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleReject(user) {
    setBusyAction(`reject-${user.id}`);
    try {
      await rejectAdminUser(user.id);
      await loadUsers();
      setMessage(`已拒绝 ${user.displayName || user.email || "用户"}。`);
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "拒绝用户失败。");
    } finally {
      setBusyAction("");
    }
  }

  async function handleSaveMembership(form) {
    setBusyAction(`membership-${form.userId}`);
    try {
      await updateAdminMembership(form.userId, membershipPayloadFromForm(form));
      setMembershipDialog(null);
      await loadUsers();
      setMessage("会员权限已更新。");
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || "会员权限更新失败。");
    } finally {
      setBusyAction("");
    }
  }

  const showInitialLoading = initialLoading && loadState === "loading";

  return (
    <div className="admin-dashboard-next">
      <section className="admin-panel-next">
        <div className="admin-panel-head-next">
          <div>
            <h2>管理后台</h2>
            <p>处理注册用户、审批状态、会员期限、运行日志和上线前检查。</p>
          </div>
          <button className={`secondary-action compact ${busyAction ? "loading" : ""}`} type="button" disabled={Boolean(busyAction)} onClick={handleRefreshCurrent}>
            {busyAction ? "刷新中" : "↻ 刷新后台"}
          </button>
        </div>

        <div className="admin-tabs-next" role="tablist" aria-label="管理后台">
          {adminTabs.map((tab) => (
            <button
              className={activeTab === tab.id ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              key={tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {showInitialLoading ? (
          <PageLoading label="正在读取管理后台" />
        ) : activeTab === "users" ? (
          <>
            <section className="admin-metrics-next" aria-label="用户统计">
              <MetricCard label="待审批" value={metrics.pending} />
              <MetricCard label="已通过" value={metrics.approved} />
              <MetricCard label="已到期" value={metrics.expired} />
            </section>
            <UserApprovalPane
              users={users}
              busyAction={busyAction}
              onApprove={handleApprove}
              onReject={handleReject}
              onEditMembership={(user) => setMembershipDialog(membershipDialogFromUser(user))}
            />
          </>
        ) : null}

        {!showInitialLoading && activeTab === "teams" ? (
          <TeamsPane
            teams={teams}
            busyAction={busyAction}
            onUpdateTeam={handleUpdateTeam}
          />
        ) : null}

        {!showInitialLoading && activeTab === "runLogs" ? (
          <RunLogsPane
            users={users}
            activeUserId={activeUserId}
            selectedTaskType={selectedTaskType}
            selectedStatus={selectedLogStatus}
            selectedDays={selectedLogDays}
            summary={runtimeSummary}
            events={runLogs}
            onUserChange={setSelectedLogUserId}
            onTaskTypeChange={setSelectedTaskType}
            onStatusChange={setSelectedLogStatus}
            onDaysChange={setSelectedLogDays}
            onRefresh={() => loadRunLogs()}
          />
        ) : null}

        {!showInitialLoading && activeTab === "audit" ? (
          <AuditPane
            users={users}
            events={auditEvents}
            selectedUserId={selectedAuditUserId}
            selectedAction={selectedAuditAction}
            onUserChange={setSelectedAuditUserId}
            onActionChange={setSelectedAuditAction}
            onRefresh={() => loadAudit()}
          />
        ) : null}

        {!showInitialLoading && activeTab === "deploy" ? <DeploymentPane deployment={deployment} /> : null}

        {!showInitialLoading && activeTab === "system" ? <SystemPane status={systemStatus} /> : null}

        <p className={`admin-sync-message-next ${loadState}`}>{message}</p>
      </section>

      {membershipDialog ? (
        <MembershipDialog
          form={membershipDialog}
          busy={busyAction === `membership-${membershipDialog.userId}`}
          onChange={setMembershipDialog}
          onClose={() => setMembershipDialog(null)}
          onSubmit={handleSaveMembership}
        />
      ) : null}
    </div>
  );
}

function UserApprovalPane({ users, busyAction, onApprove, onReject, onEditMembership }) {
  if (!users.length) {
    return <article className="admin-empty-next">暂无注册用户。</article>;
  }

  return (
    <div className="admin-list-next">
      {users.map((user) => {
        const membership = user.membership || {};
        const approval = user.approvalStatus || "pending";
        const membershipState = membershipLabel(user);
        return (
          <article className="admin-user-card-next" key={user.id}>
            <div className="admin-user-main-next">
              <h3>{user.displayName || user.email || "未命名用户"}</h3>
              <p>{user.email || user.id}</p>
              <div className="admin-chip-row-next">
                <StatusPill tone={approval}>{approvalLabel(approval)}</StatusPill>
                <StatusPill tone={membershipState.className}>{membershipState.text}</StatusPill>
                <StatusPill>{planLabel(membership.plan)}</StatusPill>
                <StatusPill>工作流 {Number(membership.workflowLimit || membership.dailyQuota || 0)}</StatusPill>
                <StatusPill>并发 {Number(membership.concurrentJobs || 0)}</StatusPill>
                <StatusPill>资产/类 {Number(membership.assetLimitPerType || 0)}</StatusPill>
                {membership.plan === "team" ? <StatusPill>席位 {Number(membership.teamSeatLimit || 1)}</StatusPill> : null}
              </div>
            </div>
            <div className="admin-user-actions-next">
              <button className="secondary-action compact" type="button" disabled={Boolean(busyAction)} onClick={() => onEditMembership(user)}>
                会员期限
              </button>
              <button className="primary-action compact" type="button" disabled={Boolean(busyAction)} onClick={() => onApprove(user)}>
                通过
              </button>
              <button className="admin-danger-action-next" type="button" disabled={Boolean(busyAction)} onClick={() => onReject(user)}>
                拒绝
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function TeamsPane({ teams, busyAction, onUpdateTeam }) {
  if (!teams.length) {
    return (
      <div className="admin-pane-next">
        <article className="admin-empty-next">暂无团队。</article>
      </div>
    );
  }

  return (
    <div className="admin-pane-next">
      <div className="admin-list-next">
        {teams.map((team) => (
          <TeamCard
            team={team}
            busy={busyAction === `team-${team.id}`}
            onUpdateTeam={onUpdateTeam}
            key={team.id}
          />
        ))}
      </div>
    </div>
  );
}

function TeamCard({ team, busy, onUpdateTeam }) {
  const [seatLimit, setSeatLimit] = useState(String(team.seatLimit || 1));
  useEffect(() => {
    setSeatLimit(String(team.seatLimit || 1));
  }, [team.seatLimit]);

  const ownerLabel = team.owner?.displayName || team.owner?.email || team.ownerUserId || "未知所有者";
  return (
    <article className="admin-user-card-next">
      <div className="admin-user-main-next">
        <h3>{team.name || "未命名团队"}</h3>
        <p>{ownerLabel}</p>
        <div className="admin-chip-row-next">
          <StatusPill tone={team.status === "active" ? "approved" : "rejected"}>{team.status === "active" ? "启用" : "停用"}</StatusPill>
          <StatusPill>邀请码 {team.inviteCode || "-"}</StatusPill>
          <StatusPill>席位 {Number(team.seatUsed || 0)}/{Number(team.seatLimit || 0)}</StatusPill>
          <StatusPill>{formatDateOnly(team.createdAt)}</StatusPill>
        </div>
      </div>
      <div className="admin-user-actions-next">
        <input
          className="admin-inline-number-next"
          type="number"
          min="1"
          step="1"
          value={seatLimit}
          onChange={(event) => setSeatLimit(event.target.value)}
          aria-label="团队席位"
        />
        <button className="secondary-action compact" type="button" disabled={busy} onClick={() => onUpdateTeam(team, { seatLimit: Number(seatLimit || team.seatLimit || 1) })}>
          {busy ? "保存中" : "保存席位"}
        </button>
        <button className="admin-danger-action-next" type="button" disabled={busy} onClick={() => onUpdateTeam(team, { status: team.status === "active" ? "deleted" : "active" })}>
          {team.status === "active" ? "停用" : "启用"}
        </button>
      </div>
    </article>
  );
}

function RunLogsPane({ users, activeUserId, selectedTaskType, selectedStatus, selectedDays, summary, events, onUserChange, onTaskTypeChange, onStatusChange, onDaysChange, onRefresh }) {
  return (
    <div className="admin-pane-next">
      <div className="admin-toolbar-next">
        <select value={activeUserId} onChange={(event) => onUserChange(event.target.value)} aria-label="选择用户">
          {users.length ? (
            users.map((user) => (
              <option value={user.id} key={user.id}>
                {user.displayName || user.email || user.id}
              </option>
            ))
          ) : (
            <option value="">暂无用户</option>
          )}
        </select>
        <select value={selectedTaskType} onChange={(event) => onTaskTypeChange(event.target.value)} aria-label="选择任务类型">
          <option value="">全部请求类型</option>
          <option value="llm">LLM</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="video-query">视频查询</option>
        </select>
        <select value={selectedStatus} onChange={(event) => onStatusChange(event.target.value)} aria-label="筛选请求状态">
          <option value="">全部状态</option>
          <option value="failed">失败</option>
          <option value="success">成功</option>
        </select>
        <select value={selectedDays} onChange={(event) => onDaysChange(event.target.value)} aria-label="筛选时间范围">
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
        </select>
        <button className="secondary-action compact" type="button" onClick={onRefresh}>
          刷新日志
        </button>
      </div>

      <section className="admin-metrics-next compact" aria-label="运行日志概览">
        <MetricCard label="后端请求" value={Number(summary.totalRequests || 0)} />
        <MetricCard label="失败请求" value={Number(summary.failedRequests || 0)} />
        <MetricCard label="平均耗时" value={`${Number(summary.averageDurationMs || 0)}ms`} />
      </section>

      <div className="admin-list-next">
        {activeUserId ? (
          events.length ? (
            events.map((event) => <RunLogCard event={event} key={event.id || event.requestId || `${event.createdAt}-${event.model}`} />)
          ) : (
            <article className="admin-empty-next">这个用户暂时没有模型请求记录。</article>
          )
        ) : (
          <article className="admin-empty-next">暂无可查看运行日志的用户。</article>
        )}
      </div>
    </div>
  );
}

function RunLogCard({ event }) {
  const isSuccess = Number(event.statusCode || 0) >= 200 && Number(event.statusCode || 0) < 400;
  const endpointLabel = event.endpointPath || event.model || "后端请求";
  const requestIdLabel = compactMiddleText(event.requestId, 10, 8);
  const upstreamRequestIdLabel = compactMiddleText(event.upstreamRequestId, 10, 8);
  const errorLabel = compactLogText(event.errorMessage, 84);
  return (
    <article className="admin-log-card-next">
      <div className="admin-log-main-next">
        <h3 title={endpointLabel}>{endpointLabel}</h3>
        <p>{event.provider || "未知渠道"} · {event.model || "未知模型"} · {taskTypeLabel(event.taskType)} · {formatDateTime(event.createdAt)}</p>
      </div>
      <div className="admin-chip-row-next admin-log-chip-row-next">
        <StatusPill tone={isSuccess ? "approved" : "rejected"}>{event.statusCode || 0}</StatusPill>
        <StatusPill>{Number(event.durationMs || 0)}ms</StatusPill>
        <StatusPill>{event.method || "POST"}</StatusPill>
        {event.requestId ? <StatusPill title={`请求 ID ${event.requestId}`}>ID {requestIdLabel}</StatusPill> : null}
        {event.upstreamRequestId ? <StatusPill title={`上游请求 ID ${event.upstreamRequestId}`}>上游 {upstreamRequestIdLabel}</StatusPill> : null}
        {event.errorMessage ? <StatusPill tone="rejected" className="admin-error-pill-next" title={event.errorMessage}>错误 {errorLabel}</StatusPill> : null}
      </div>
    </article>
  );
}

function AuditPane({ users, events, selectedUserId, selectedAction, onUserChange, onActionChange, onRefresh }) {
  return (
    <div className="admin-pane-next">
      <div className="admin-toolbar-next admin-audit-toolbar-next">
        <select value={selectedUserId} onChange={(event) => onUserChange(event.target.value)} aria-label="筛选用户">
          <option value="">全部用户</option>
          {users.map((user) => (
            <option value={user.id} key={user.id}>
              {user.displayName || user.email || user.id}
            </option>
          ))}
        </select>
        <select value={selectedAction} onChange={(event) => onActionChange(event.target.value)} aria-label="筛选操作">
          <option value="">全部操作</option>
          <option value="user.approve">通过用户</option>
          <option value="user.reject">拒绝用户</option>
          <option value="membership.update">修改会员</option>
          <option value="team.update">修改团队</option>
        </select>
        <button className="secondary-action compact" type="button" onClick={onRefresh}>
          刷新日志
        </button>
      </div>

      <div className="admin-list-next">
        {events.length ? (
          events.map((event) => <AuditCard event={event} users={users} key={event.id || `${event.createdAt}-${event.action}`} />)
        ) : (
          <article className="admin-empty-next">暂时没有后台操作记录。</article>
        )}
      </div>
    </div>
  );
}

function AuditCard({ event, users }) {
  const details = event.details || {};
  const membership = details.membership || {};
  const target = event.targetEmail || users.find((user) => user.id === event.targetUserId)?.email || event.targetUserId || "未知用户";
  return (
    <article className="admin-log-card-next audit">
      <div>
        <h3>{auditActionLabel(event.action)}</h3>
        <p>{formatDateTime(event.createdAt)} · 操作人 {event.actorEmail || "系统"}</p>
      </div>
      <div className="admin-chip-row-next admin-audit-chip-row-next">
        <StatusPill>用户 {target}</StatusPill>
        {membership.plan ? <StatusPill>{planLabel(membership.plan)}</StatusPill> : null}
        {membership.endsAt ? <StatusPill>至 {formatDateTime(membership.endsAt)}</StatusPill> : null}
        {membership.workflowLimit ? <StatusPill>工作流 {Number(membership.workflowLimit)}</StatusPill> : null}
        {membership.concurrentJobs ? <StatusPill>并发 {Number(membership.concurrentJobs)}</StatusPill> : null}
      </div>
    </article>
  );
}

function DeploymentPane({ deployment }) {
  const counts = deployment.counts || {};
  const checks = Array.isArray(deployment.checks) ? deployment.checks : [];
  return (
    <div className="admin-pane-next">
      <section className="admin-metrics-next compact" aria-label="上线体检概览">
        <MetricCard label="已通过" value={Number(counts.pass || 0)} />
        <MetricCard label="需确认" value={Number(counts.warn || 0)} />
        <MetricCard label="需处理" value={Number(counts.fail || 0)} />
      </section>
      <div className="admin-system-grid-next deployment">
        {checks.length ? (
          checks.map((item) => (
            <article className={`admin-system-card-next ${item.status || "warn"}`} key={item.id || item.title}>
              <span>{deploymentStatusLabel(item.status)}</span>
              <strong>{item.title || "体检项"}</strong>
              <p>{item.message || ""}</p>
              {item.detail ? <p className="admin-detail-next">{item.detail}</p> : null}
            </article>
          ))
        ) : (
          <article className="admin-empty-next">暂无体检项目。</article>
        )}
      </div>
    </div>
  );
}

function SystemPane({ status }) {
  if (!status) return <article className="admin-empty-next">暂时没有系统状态数据。</article>;
  const storage = status.storage || {};
  const objectStorage = storage.objectStorage || {};
  const cards = [
    ["运行环境", status.server?.env || "development", `允许来源：${status.server?.appOrigin || "*"}`],
    ["数据存储", storage.driver || "-", `数据库：${storage.databaseConfigured ? "已配置" : "未配置"} · PostgreSQL：${storage.postgres?.ready ? "启用" : "未启用"}`],
    ["对象存储", objectStorage.provider || "local", objectStorage.configured ? `Bucket：${objectStorage.bucket || "本地文件"}` : "配置不完整"],
    ["并发状态", `${status.concurrency?.active || 0}/${status.concurrency?.limit || 0}`, `等待中：${status.concurrency?.queued || 0}`],
  ];

  return (
    <div className="admin-system-grid-next">
      {cards.map(([title, value, desc]) => (
        <article className="admin-system-card-next" key={title}>
          <span>{title}</span>
          <strong>{value}</strong>
          <p>{desc}</p>
        </article>
      ))}
    </div>
  );
}

function MembershipDialog({ form, busy, onChange, onClose, onSubmit }) {
  const plan = membershipPlans[form.plan] || membershipPlans.basic;

  function updatePlan(planId) {
    const nextPlan = membershipPlans[planId] || membershipPlans.basic;
    onChange({
      ...form,
      plan: planId,
      workflowLimit: nextPlan.workflowLimit,
      concurrentJobs: nextPlan.concurrentJobs,
      assetLimitPerType: nextPlan.assetLimitPerType,
      teamSeatLimit: nextPlan.teamSeatLimit,
    });
  }

  function updateDuration(duration) {
    onChange({
      ...form,
      duration,
      endsAt: toDateTimeLocalValue(calculateMembershipEnd(duration)),
    });
  }

  return (
    <div className="admin-dialog-backdrop-next" role="presentation">
      <form className="admin-dialog-next" onSubmit={(event) => {
        event.preventDefault();
        onSubmit(form);
      }}>
        <div className="admin-dialog-head-next">
          <div>
            <span>Membership</span>
            <h3>会员期限</h3>
            <p>{form.userLabel}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="admin-dialog-grid-next">
          <label>
            套餐
            <select value={form.plan} onChange={(event) => updatePlan(event.target.value)}>
              {Object.entries(membershipPlans).map(([id, item]) => (
                <option value={id} key={id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label>
            快速期限
            <select value={form.duration} onChange={(event) => updateDuration(event.target.value)}>
              <option value="month">1 个月</option>
              <option value="quarter">3 个月</option>
              <option value="year">1 年</option>
            </select>
          </label>
          <label>
            到期时间
            <input type="datetime-local" value={form.endsAt} onChange={(event) => onChange({ ...form, endsAt: event.target.value })} />
          </label>
          <label>
            工作流数量
            <input type="number" min="1" step="1" value={form.workflowLimit} onChange={(event) => onChange({ ...form, workflowLimit: event.target.value })} />
          </label>
          <label>
            并发任务
            <input type="number" min="1" step="1" value={form.concurrentJobs} onChange={(event) => onChange({ ...form, concurrentJobs: event.target.value })} />
          </label>
          <label>
            资产/类上限
            <input type="number" min="1" step="1" value={form.assetLimitPerType} onChange={(event) => onChange({ ...form, assetLimitPerType: event.target.value })} />
          </label>
          <label>
            团队席位
            <input type="number" min="1" step="1" value={form.teamSeatLimit} onChange={(event) => onChange({ ...form, teamSeatLimit: event.target.value })} />
          </label>
        </div>

        <p className="admin-dialog-note-next">当前选择：{plan.name} · 工作流 {plan.workflowLimit} · 并发 {plan.concurrentJobs} · 资产/类 {plan.assetLimitPerType}{form.plan === "team" ? ` · 席位 ${form.teamSeatLimit}` : ""}</p>

        <div className="admin-dialog-actions-next">
          <button className="secondary-action compact" type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary-action compact" type="submit" disabled={busy}>
            {busy ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

function MetricCard({ label, value }) {
  return (
    <article>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function StatusPill({ tone = "", className = "", title = "", children }) {
  return (
    <span className={["admin-status-pill-next", tone, className].filter(Boolean).join(" ")} title={title || undefined}>
      <span>{children}</span>
    </span>
  );
}

function compactMiddleText(value, headLength = 12, tailLength = 8) {
  const text = normalizeLogText(value);
  const maxLength = headLength + tailLength + 3;
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, headLength)}...${text.slice(-tailLength)}`;
}

function compactLogText(value, maxLength = 96) {
  const text = normalizeLogText(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeLogText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isRunLogErrorMessage(message) {
  return /backend_request_logs|运行日志读取失败|relation .*does not exist/i.test(String(message || ""));
}

function adminMetrics(users) {
  return {
    pending: users.filter((user) => user.approvalStatus === "pending").length,
    approved: users.filter((user) => user.approvalStatus === "approved").length,
    expired: users.filter((user) => user.membership?.endsAt && Date.parse(user.membership.endsAt) <= Date.now()).length,
  };
}

function membershipDialogFromUser(user) {
  const membership = user.membership || {};
  const plan = membership.plan && membershipPlans[membership.plan] ? membership.plan : "basic";
  return {
    userId: user.id,
    userLabel: user.displayName || user.email || user.id,
    plan,
    duration: "month",
    endsAt: toDateTimeLocalValue(membership.endsAt || calculateMembershipEnd("month")),
    workflowLimit: Number(membership.workflowLimit || membership.dailyQuota || membershipPlans[plan].workflowLimit),
    concurrentJobs: Number(membership.concurrentJobs || membershipPlans[plan].concurrentJobs),
    assetLimitPerType: Number(membership.assetLimitPerType || membershipPlans[plan].assetLimitPerType),
    teamSeatLimit: Number(membership.teamSeatLimit || membershipPlans[plan].teamSeatLimit || 1),
  };
}

function approvalMembershipPayload(user) {
  const membership = user?.membership || {};
  const planId = membership.plan && membershipPlans[membership.plan] ? membership.plan : "basic";
  const plan = membershipPlans[planId] || membershipPlans.basic;
  return {
    status: "active",
    plan: planId,
    startsAt: membership.startsAt || new Date().toISOString(),
    endsAt: membership.endsAt || calculateMembershipEnd("month").toISOString(),
    workflowLimit: Number(membership.workflowLimit || membership.dailyQuota || plan.workflowLimit),
    concurrentJobs: Number(membership.concurrentJobs || plan.concurrentJobs),
    assetLimitPerType: Number(membership.assetLimitPerType || plan.assetLimitPerType),
    teamSeatLimit: Number(membership.teamSeatLimit || plan.teamSeatLimit),
  };
}

function membershipPayloadFromForm(form) {
  return {
    status: "active",
    plan: form.plan,
    startsAt: new Date().toISOString(),
    endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : calculateMembershipEnd("month").toISOString(),
    workflowLimit: Number(form.workflowLimit || membershipPlans[form.plan]?.workflowLimit || 10),
    concurrentJobs: Number(form.concurrentJobs || membershipPlans[form.plan]?.concurrentJobs || 2),
    assetLimitPerType: Number(form.assetLimitPerType || membershipPlans[form.plan]?.assetLimitPerType || 10),
    teamSeatLimit: Number(form.teamSeatLimit || membershipPlans[form.plan]?.teamSeatLimit || 1),
  };
}

function calculateMembershipEnd(duration) {
  const date = new Date();
  const months = duration === "year" ? 12 : duration === "quarter" ? 3 : 1;
  date.setMonth(date.getMonth() + months);
  date.setSeconds(0, 0);
  return date;
}

function toDateTimeLocalValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
}

function planLabel(plan) {
  return membershipPlans[plan]?.name || "未选套餐";
}

function approvalLabel(status) {
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已拒绝";
  return "待审批";
}

function auditActionLabel(action) {
  if (action === "user.approve") return "通过用户";
  if (action === "user.reject") return "拒绝用户";
  if (action === "membership.update") return "修改会员";
  if (action === "team.update") return "修改团队";
  return action || "后台操作";
}

function deploymentStatusLabel(status) {
  if (status === "pass") return "通过";
  if (status === "fail") return "需要处理";
  return "需要确认";
}

function membershipLabel(user) {
  const membership = user.membership || {};
  if (membership.status !== "active") return { text: "未激活", className: "pending" };
  if (membership.endsAt && Date.parse(membership.endsAt) <= Date.now()) {
    return { text: "已到期", className: "expired" };
  }
  return { text: `有效至 ${formatDateOnly(membership.endsAt)}`, className: "approved" };
}

function formatDateOnly(value) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未设置";
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${formatDateOnly(value)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function taskTypeLabel(type) {
  if (type === "llm") return "LLM";
  if (type === "image") return "图片";
  if (type === "video") return "视频";
  if (type === "video-query") return "视频查询";
  return type || "未知";
}

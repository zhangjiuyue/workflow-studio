"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { BrandMark } from "./BrandLogo";
import LanguageSwitch from "./LanguageSwitch";
import { localizedText, useLanguage } from "./LanguageProvider";
import {
  authStateLabel,
  clearAuthSession,
  readAuthToken,
  requestAuthedFlowStudioApi,
} from "../lib/flowstudio-api";
import { MEMBERSHIP_QUOTA_REACHED_EVENT } from "../lib/membership-quota.mjs";

const navItems = [
  { href: "/home", label: { zh: "首页", en: "Home" }, icon: "⌂" },
  { href: "/create", label: { zh: "自由创作", en: "Create" }, icon: "✎" },
  { href: "/workflows", label: { zh: "工作流", en: "Workflows" }, icon: "⌘" },
  { href: "/assets", label: { zh: "创意资产", en: "Assets" }, icon: "▣" },
  { href: "/settings/api", label: { zh: "API设置", en: "API Settings" }, icon: "⚙" },
  { href: "/admin", label: { zh: "管理后台", en: "Admin" }, icon: "◎", adminOnly: true },
];
const appShellText = {
  brandHome: { zh: "Workflow Studio 首页", en: "Workflow Studio home" },
  nav: { zh: "主导航", en: "Primary navigation" },
  accountMenu: { zh: "账户菜单", en: "Account menu" },
  userDot: { zh: "人", en: "U" },
  defaultUser: { zh: "Workflow Studio 用户", en: "Workflow Studio user" },
  logout: { zh: "退出登录", en: "Sign out" },
  logoutDetail: { zh: "结束当前会话", en: "End current session" },
  quotaEyebrow: { zh: "套餐额度", en: "Plan limit" },
  quotaTitle: { zh: "套餐额度已满", en: "Plan limit reached" },
  quotaMessage: {
    zh: "当前套餐额度已满，请联系客服升级套餐。",
    en: "Your current plan limit has been reached. Contact support to upgrade your plan.",
  },
  quotaResourceLabel: { zh: "无法继续保存", en: "Unable to save" },
  quotaWorkflow: { zh: "工作流", en: "Workflow" },
  quotaAsset: { zh: "创意资产", en: "Creative asset" },
  quotaHint: {
    zh: "升级套餐额度后即可继续保存更多内容。",
    en: "Upgrade your plan limit to save more content.",
  },
  quotaDismiss: { zh: "知道了", en: "Got it" },
  defaultEyebrow: { zh: "Next.js 迁移", en: "Next.js Migration" },
  sessionState: {
    ready: { zh: "会话正常", en: "Session ready" },
    warning: { zh: "待确认", en: "Needs check" },
    checking: { zh: "校验中", en: "Checking" },
    "signed-out": { zh: "未登录", en: "Signed out" },
    forbidden: { zh: "权限不足", en: "Access denied" },
  },
};

const pageText = {
  home: {
    title: { zh: "首页", en: "Home" },
    eyebrow: { zh: "Workspace", en: "Workspace" },
    description: {
      zh: "工作台概览已接入现有登录态、Railway API 和 Cloudflare R2 资产记录。",
      en: "Workspace overview connected to the current session, Railway API, and Cloudflare R2 asset records.",
    },
  },
  create: {
    title: { zh: "自由创作", en: "Create" },
    eyebrow: { zh: "Create", en: "Create" },
    description: {
      zh: "面向图片、视频、文本和音频生成的批量创作台。",
      en: "A batch creation workspace for image, video, text, and audio generation.",
    },
  },
  workflows: {
    title: { zh: "工作流", en: "Workflows" },
    eyebrow: { zh: "Workflows", en: "Workflows" },
    description: { zh: "查看工作流、配置和运行记录。", en: "View workflows, configurations, and run history." },
  },
  workflowRun: {
    title: { zh: "任务详情", en: "Run Details" },
    eyebrow: { zh: "Workflow Run", en: "Workflow Run" },
    description: {
      zh: "查看单条工作流任务的已生成结果，当前迁移阶段保持只读。",
      en: "Review generated results for a single workflow run. This migrated view is currently read-only.",
    },
  },
  assets: {
    title: { zh: "创意资产", en: "Creative Assets" },
    eyebrow: { zh: "Assets", en: "Assets" },
    description: {
      zh: "资产总览已接入现有 PostgreSQL 记录和 Cloudflare R2 文件地址。",
      en: "Asset overview connected to existing PostgreSQL records and Cloudflare R2 file URLs.",
    },
  },
  apiSettings: {
    title: { zh: "API 设置", en: "API Settings" },
    eyebrow: { zh: "Settings", en: "Settings" },
    description: {
      zh: "集中管理 LLM、图片、视频和音频渠道密钥，继续使用现有后端加密存储。",
      en: "Manage LLM, image, video, and audio provider keys in one place using the existing encrypted backend storage.",
    },
  },
  team: {
    title: { zh: "团队空间", en: "Team Workspace" },
    eyebrow: { zh: "Team Workspace", en: "Team Workspace" },
    description: { zh: "管理团队成员和共享资源。", en: "Manage team members and shared resources." },
  },
  admin: {
    title: { zh: "管理后台", en: "Admin" },
    eyebrow: { zh: "Admin", en: "Admin" },
    description: {
      zh: "处理内测用户审批、会员期限、运行日志、上线体检和系统状态。",
      en: "Handle beta approvals, membership periods, run logs, launch checks, and system status.",
    },
  },
};

export default function AppShell({ title, eyebrow, description, pageClassName = "", requiredRole = "", children }) {
  const router = useRouter();
  const pathname = usePathname();
  const { language, t } = useLanguage();
  const { user, sessionState, sessionMessageText } = useAuth();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [quotaDialog, setQuotaDialog] = useState(null);
  const accountMenuRef = useRef(null);

  useEffect(() => {
    if (sessionState === "signed-out") {
      router.replace("/login");
      return;
    }
    if (sessionState === "ready" && requiredRole && user?.role !== requiredRole) {
      router.replace("/home");
    }
  }, [requiredRole, router, sessionState, user?.role]);

  useEffect(() => {
    if (!accountMenuOpen) return undefined;

    function handlePointerDown(event) {
      if (accountMenuRef.current?.contains(event.target)) return;
      setAccountMenuOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setAccountMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    function handleQuotaReached(event) {
      setAccountMenuOpen(false);
      setQuotaDialog(event.detail || {});
    }

    function handleQuotaKeyDown(event) {
      if (event.key === "Escape") setQuotaDialog(null);
    }

    window.addEventListener(MEMBERSHIP_QUOTA_REACHED_EVENT, handleQuotaReached);
    window.addEventListener("keydown", handleQuotaKeyDown);
    return () => {
      window.removeEventListener(MEMBERSHIP_QUOTA_REACHED_EVENT, handleQuotaReached);
      window.removeEventListener("keydown", handleQuotaKeyDown);
    };
  }, []);

  const visibleNav = useMemo(() => navItems.filter((item) => !item.adminOnly || user?.role === "admin"), [user]);
  const statusLabel = authStateLabel(user, language);
  const accountMetaLabel = accountMembershipLabel(user, statusLabel, language);
  const currentPageText = pageTextForPath(pathname);
  const displayTitle = localizedText(currentPageText?.title, language) || localizedText(title, language);
  const displayEyebrow = localizedText(currentPageText?.eyebrow, language) || localizedText(eyebrow, language) || t(appShellText.defaultEyebrow);
  const displayDescription = localizedText(currentPageText?.description, language) || localizedText(description, language);
  const sessionMessage = sessionMessageText || statusLabel;
  const membershipEndsAt = user?.membership?.endsAt;
  const membershipExpired = membershipEndsAt && Date.parse(membershipEndsAt) <= Date.now();
  const accountClassName = [
    "account-pill",
    user?.approvalStatus === "pending" ? "pending" : "",
    user?.approvalStatus === "rejected" ? "rejected" : "",
    membershipExpired ? "expired" : "",
  ].filter(Boolean).join(" ");

  async function handleLogout() {
    try {
      if (readAuthToken()) {
        await requestAuthedFlowStudioApi("/api/auth/logout", {
          method: "POST",
          body: JSON.stringify({}),
        });
      }
    } catch {
      // Local cleanup is enough for the migration shell if the remote session is already gone.
    }
    clearAuthSession();
    router.replace("/login");
  }

  const routeAuthorized = sessionState === "ready" && user && (!requiredRole || user.role === requiredRole);
  if (!routeAuthorized) return null;

  return (
    <div className="app-shell">
      <header className="site-nav">
        <Link className="brand" href="/home" aria-label={t(appShellText.brandHome)}>
          <BrandMark aria-hidden="true" />
          <span>Workflow Studio</span>
        </Link>

        <nav className="nav-list" aria-label={t(appShellText.nav)}>
          {visibleNav.map((item) => (
            <Link key={item.href} className={`nav-item ${isActivePath(pathname, item.href) ? "active" : ""}`} href={item.href}>
              <span className="icon">{item.icon}</span>
              <span>{localizedText(item.label, language)}</span>
            </Link>
          ))}
        </nav>

        <div className="account-actions">
          <LanguageSwitch />
          <div className="account-menu-wrap" ref={accountMenuRef}>
            <button className={accountClassName} type="button" onClick={() => setAccountMenuOpen((open) => !open)} aria-expanded={accountMenuOpen} title={t(appShellText.accountMenu)}>
              <span className="user-dot">{t(appShellText.userDot)}</span>
              <span>
                <strong>{user?.displayName || user?.email || t(appShellText.defaultUser)}</strong>
                <small>{accountMetaLabel}</small>
              </span>
            </button>
            {accountMenuOpen ? (
              <div className="account-menu-next">
                <Link href="/team" onClick={() => setAccountMenuOpen(false)}>
                  <strong>{teamEntryLabel(user, language)}</strong>
                  <small>{teamEntryDetail(user, language)}</small>
                </Link>
                <button type="button" onClick={handleLogout}>
                  <strong>{t(appShellText.logout)}</strong>
                  <small>{t(appShellText.logoutDetail)}</small>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className={["workspace-page", pageClassName].filter(Boolean).join(" ")}>
        <section className="workspace-hero">
          <div>
            <p className="eyebrow">{displayEyebrow}</p>
            <h1>{displayTitle}</h1>
            <p>{displayDescription}</p>
          </div>
          <div className={`session-banner ${sessionState}`}>
            <span>{localizedText(appShellText.sessionState[sessionState] || appShellText.sessionState.checking, language)}</span>
            <strong>{sessionMessage}</strong>
          </div>
        </section>

        {children}
      </main>
      {quotaDialog ? (
        <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={() => setQuotaDialog(null)}>
          <section className="workflow-image-retry-dialog-next workflow-action-dialog-next membership-quota-dialog-next" role="dialog" aria-modal="true" aria-label={t(appShellText.quotaTitle)} onClick={(event) => event.stopPropagation()}>
            <button className="workflow-dialog-close-next" type="button" onClick={() => setQuotaDialog(null)} aria-label={language === "en" ? "Close" : "关闭"}>×</button>
            <div className="workflow-dialog-title-next">
              <span>{t(appShellText.quotaEyebrow)}</span>
              <h3>{t(appShellText.quotaTitle)}</h3>
              <p>{t(appShellText.quotaMessage)}</p>
            </div>
            <article className="workflow-dialog-step-next notice">
              <span>{t(appShellText.quotaResourceLabel)}</span>
              <strong>{t(quotaDialog.resource === "workflow" ? appShellText.quotaWorkflow : appShellText.quotaAsset)}</strong>
              <p>{t(appShellText.quotaHint)}</p>
            </article>
            <div className="workflow-dialog-actions-next">
              <button className="primary-action compact" type="button" onClick={() => setQuotaDialog(null)}>
                {t(appShellText.quotaDismiss)}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function pageTextForPath(pathname = "") {
  if (pathname === "/" || pathname.startsWith("/home")) return pageText.home;
  if (pathname.startsWith("/workflows/run")) return pageText.workflowRun;
  if (pathname.startsWith("/workflows")) return pageText.workflows;
  if (pathname.startsWith("/create")) return pageText.create;
  if (pathname.startsWith("/assets")) return pageText.assets;
  if (pathname.startsWith("/settings/api")) return pageText.apiSettings;
  if (pathname.startsWith("/team")) return pageText.team;
  if (pathname.startsWith("/admin")) return pageText.admin;
  return null;
}

function isActivePath(pathname, href) {
  if (href === "/home") return pathname === "/home" || pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function accountMembershipLabel(user, fallbackLabel, language) {
  if (!user) return fallbackLabel;
  const membership = user.membership || {};
  const planLabel = membershipPlanLabel(membership.plan || (user.role === "admin" ? "pro" : "basic"), language);
  if (membership.endsAt && Date.parse(membership.endsAt) <= Date.now()) {
    return language === "en"
      ? `${planLabel} · Expired · ${formatDateTimeWithSeconds(membership.endsAt, language)}`
      : `${planLabel} · 会员已到期 · ${formatDateTimeWithSeconds(membership.endsAt, language)}`;
  }
  if (membership.status === "active") {
    return `${planLabel} · ${formatDateTimeWithSeconds(membership.endsAt, language)}`;
  }
  return `${planLabel} · ${fallbackLabel}`;
}

function membershipPlanLabel(plan, language) {
  if (language === "en") {
    if (plan === "team") return "Team";
    if (plan === "pro") return "Pro";
    return "Basic";
  }
  if (plan === "team") return "团队版";
  if (plan === "pro") return "高级版";
  return "基础版";
}

function teamEntryLabel(user, language) {
  const team = user?.team;
  if (!team) return language === "en" ? "Team workspace" : "团队空间";
  if (language === "en") return team.role === "owner" ? "Team management" : "My team";
  return team.role === "owner" ? "团队管理" : "我的团队";
}

function teamEntryDetail(user, language) {
  const team = user?.team;
  if (!team) return language === "en" ? "Start a team or join with an invite code" : "开通或输入邀请码加入";
  if (team.role === "owner") {
    const teamName = team.name || (language === "en" ? "Team" : "团队");
    return language === "en"
      ? `${teamName} · ${team.seatUsed || 0}/${team.seatLimit || 0} seats`
      : `${teamName} · ${team.seatUsed || 0}/${team.seatLimit || 0} 席`;
  }
  return language === "en" ? `Joined ${team.name || "Team"}` : `已加入 ${team.name || "团队"}`;
}

function formatDateTimeWithSeconds(value, language) {
  const emptyLabel = language === "en" ? "No expiry set" : "未设置期限";
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("/");
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
  return `${day} ${time}`;
}

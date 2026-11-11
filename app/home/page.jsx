import AppShell from "../../components/AppShell";
import HomeDashboard from "./HomeDashboard";

export default function HomePage() {
  return (
    <AppShell
      title="首页"
      eyebrow="Workspace"
      description="工作台概览已接入现有登录态、Railway API 和 Cloudflare R2 资产记录。"
      pageClassName="home-workspace-page-next"
    >
      <HomeDashboard />
    </AppShell>
  );
}

import AppShell from "../../components/AppShell";
import TeamDashboard from "./TeamDashboard";

export default function TeamPage() {
  return (
    <AppShell
      title="团队空间"
      eyebrow="Team Workspace"
      description="管理团队成员和共享资源。"
      pageClassName="team-page-next"
    >
      <TeamDashboard />
    </AppShell>
  );
}

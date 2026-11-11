import AppShell from "../../components/AppShell";
import CreateDashboard from "./CreateDashboard";

export default function CreatePage() {
  return (
    <AppShell
      title="自由创作"
      eyebrow="Create"
      description="面向图片、视频、文本和音频生成的批量创作台。"
      pageClassName="create-workspace-page-next"
    >
      <CreateDashboard />
    </AppShell>
  );
}

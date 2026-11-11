import AppShell from "../../components/AppShell";
import WorkflowsDashboard from "./WorkflowsDashboard";

export default function WorkflowsPage() {
  return (
    <AppShell
      title="工作流"
      eyebrow="Workflows"
      description="查看工作流、配置和运行记录。"
      pageClassName="workflow-workspace-page-next"
    >
      <WorkflowsDashboard />
    </AppShell>
  );
}

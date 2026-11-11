import { Suspense } from "react";
import AppShell from "../../../components/AppShell";
import WorkflowRunDetailDashboard from "./WorkflowRunDetailDashboard";

export default function WorkflowRunPage() {
  return (
    <AppShell
      title="任务详情"
      eyebrow="Workflow Run"
      description="查看单条工作流任务的已生成结果，当前迁移阶段保持只读。"
      pageClassName="workflow-run-shell-next"
    >
      <Suspense fallback={<section className="workflow-panel-next">正在读取任务...</section>}>
        <WorkflowRunDetailDashboard />
      </Suspense>
    </AppShell>
  );
}

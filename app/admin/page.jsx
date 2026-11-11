import AppShell from "../../components/AppShell";
import AdminDashboard from "./AdminDashboard";

export default function AdminPage() {
  return (
    <AppShell
      title="管理后台"
      eyebrow="Admin"
      description="处理内测用户审批、会员期限、运行日志、上线体检和系统状态。"
      pageClassName="admin-workspace-page-next"
      requiredRole="admin"
    >
      <AdminDashboard />
    </AppShell>
  );
}

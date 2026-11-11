import AppShell from "../../../components/AppShell";
import ApiSettingsDashboard from "./ApiSettingsDashboard";

export default function ApiSettingsPage() {
  return (
    <AppShell
      title="API 设置"
      eyebrow="Settings"
      description="集中管理 LLM、图片、视频和音频渠道密钥，继续使用现有后端加密存储。"
      pageClassName="api-settings-page-next"
    >
      <ApiSettingsDashboard />
    </AppShell>
  );
}

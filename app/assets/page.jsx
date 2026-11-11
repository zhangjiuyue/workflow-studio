import AppShell from "../../components/AppShell";
import AssetsDashboard from "./AssetsDashboard";

export default function AssetsPage() {
  return (
    <AppShell
      title="创意资产"
      eyebrow="Assets"
      description="资产总览已接入现有 PostgreSQL 记录和 Cloudflare R2 文件地址。"
      pageClassName="assets-page-next"
    >
      <AssetsDashboard />
    </AppShell>
  );
}

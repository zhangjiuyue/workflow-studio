"use client";

import { useLanguage } from "./LanguageProvider";

export default function PageLoading({ label }) {
  const { t } = useLanguage();
  const displayLabel = label || t({ zh: "正在读取", en: "Loading" });

  return (
    <div className="workflow-page-loading-next page-loading-next" role="status" aria-live="polite">
      <span className="workflow-refresh-spinner-next" aria-hidden="true"></span>
      <strong>{displayLabel}</strong>
    </div>
  );
}

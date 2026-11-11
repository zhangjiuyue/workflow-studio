"use client";

import { useLanguage } from "./LanguageProvider";

export default function ModulePlaceholder({ title, description, items = [] }) {
  const { t } = useLanguage();

  return (
    <section className="module-panel">
      <div>
        <p className="eyebrow">{t({ zh: "迁移模块", en: "Migration Module" })}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="module-grid">
        {items.map((item) => (
          <article className="module-card" key={item.title}>
            <span>{item.status || t({ zh: "待迁移", en: "Pending migration" })}</span>
            <h3>{item.title}</h3>
            <p>{item.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

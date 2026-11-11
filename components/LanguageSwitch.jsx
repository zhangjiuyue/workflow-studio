"use client";

import { useLanguage } from "./LanguageProvider";

const labels = {
  switchTo: {
    zh: "切换到 English",
    en: "Switch to Chinese",
  },
};

export default function LanguageSwitch({ className = "" }) {
  const { language, toggleLanguage, t } = useLanguage();
  const label = t(labels.switchTo);

  return (
    <button
      className={["language-switcher", language === "en" ? "english" : "chinese", className].filter(Boolean).join(" ")}
      type="button"
      aria-label={label}
      title={label}
      onClick={toggleLanguage}
    >
      <span className="language-switch-symbol" aria-hidden="true">
        <span className="language-switch-glyph language-switch-glyph-zh">文</span>
        <span className="language-switch-glyph language-switch-glyph-en">A</span>
      </span>
    </button>
  );
}

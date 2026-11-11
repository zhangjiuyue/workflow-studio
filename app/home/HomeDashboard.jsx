"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "../../components/BrandLogo";
import { useLanguage } from "../../components/LanguageProvider";
import { LEGAL_DOCUMENT_META, LegalDocument } from "../legal-documents";

const homeText = {
  heroAria: { zh: "Workflow Studio AI 视频工作流入口", en: "Workflow Studio AI video workflow entry" },
  headline: { zh: "让创作变得简单", en: "Create with less friction" },
  subtitle: { zh: "AI视频工作流平台", en: "AI video workflow platform" },
  start: { zh: "启动工作流", en: "Start workflow" },
  footerAria: { zh: "站点页脚", en: "Site footer" },
  disclaimer: {
    zh: "Workflow Studio 是独立平台，提供受控场景下的内容协作、流程编排与工具配置；不承诺第三方服务可用性或商业结果。",
    en: "Workflow Studio is an independent platform for controlled content collaboration, workflow orchestration, and tool configuration; third-party availability and business outcomes are not guaranteed.",
  },
  copyright: { zh: "版权所有 © 2026 Workflow Studio", en: "Copyright © 2026 Workflow Studio" },
  rights: { zh: "保留所有权利", en: "All rights reserved" },
  legalAria: { zh: "法律", en: "Legal" },
  terms: { zh: "服务条款", en: "Terms of Service" },
  privacy: { zh: "隐私政策", en: "Privacy Policy" },
  beta: { zh: "Private Beta", en: "Private Beta" },
  closeDialog: { zh: "关闭弹窗", en: "Close dialog" },
  close: { zh: "关闭", en: "Close" },
  policyTitle: {
    terms: { zh: "用户协议", en: "User Agreement" },
    privacy: { zh: "隐私协议", en: "Privacy Agreement" },
  },
};

export default function HomeDashboard() {
  const { t } = useLanguage();
  const [activePolicy, setActivePolicy] = useState(null);
  const heroRef = useRef(null);
  const policyMeta = activePolicy ? LEGAL_DOCUMENT_META[activePolicy] : null;

  useEffect(() => {
    if (!activePolicy) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") setActivePolicy(null);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activePolicy]);

  useEffect(() => {
    function handleWindowPointerMove(event) {
      if (!heroRef.current) return;
      updateCinematicPointer(heroRef.current, event.clientX, event.clientY);
    }

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handleWindowPointerMove);
  }, []);

  function updateCinematicPointer(element, clientX, clientY) {
    const rect = element.getBoundingClientRect();
    const x = Math.min(Math.max((clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
    const y = Math.min(Math.max((clientY - rect.top) / Math.max(rect.height, 1), 0), 1);
    const shiftX = (x - 0.5) * 88;
    const shiftY = (y - 0.5) * 46;

    document.body.style.setProperty("--home-mx", `${clientX.toFixed(1)}px`);
    document.body.style.setProperty("--home-my", `${clientY.toFixed(1)}px`);
    element.style.setProperty("--home-pointer-x", `${(x * 100).toFixed(2)}%`);
    element.style.setProperty("--home-pointer-y", `${(y * 100).toFixed(2)}%`);
    element.style.setProperty("--home-px", x.toFixed(4));
    element.style.setProperty("--home-py", y.toFixed(4));
    element.style.setProperty("--home-shift-x", `${shiftX.toFixed(2)}px`);
    element.style.setProperty("--home-shift-y", `${shiftY.toFixed(2)}px`);
    element.style.setProperty("--home-shift-x-soft", `${(shiftX * 0.25).toFixed(2)}px`);
    element.style.setProperty("--home-shift-y-soft", `${(shiftY * 0.2).toFixed(2)}px`);
    element.style.setProperty("--home-shift-x-back", `${(shiftX * 0.35).toFixed(2)}px`);
    element.style.setProperty("--home-shift-y-back", `${(shiftY * 0.32).toFixed(2)}px`);
    element.style.setProperty("--home-shift-x-deep", `${(shiftX * -0.18).toFixed(2)}px`);
    element.style.setProperty("--home-shift-y-deep", `${(shiftY * 0.18).toFixed(2)}px`);
    element.style.setProperty("--home-shift-x-mid", `${(shiftX * -0.24).toFixed(2)}px`);
    element.style.setProperty("--home-shift-y-mid", `${(shiftY * 0.22).toFixed(2)}px`);
    element.style.setProperty("--home-shift-x-front", `${(shiftX * 0.12).toFixed(2)}px`);
    element.style.setProperty("--home-shift-y-front", `${(shiftY * -0.18).toFixed(2)}px`);
    element.style.setProperty("--home-shift-x-low", `${(shiftX * -0.32).toFixed(2)}px`);
    element.style.setProperty("--home-shift-y-low", `${(shiftY * -0.12).toFixed(2)}px`);
    element.style.setProperty("--home-shift-x-side", `${(shiftX * 0.18).toFixed(2)}px`);
    element.style.setProperty("--home-shift-y-side", `${(shiftY * 0.24).toFixed(2)}px`);
    element.style.setProperty("--home-tilt", `${((y - 0.5) * 8).toFixed(2)}deg`);
  }

  function handleCinematicPointerMove(event) {
    updateCinematicPointer(event.currentTarget, event.clientX, event.clientY);
  }

  function handlePrismPanelPointerMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max((event.clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
    const y = Math.min(Math.max((event.clientY - rect.top) / Math.max(rect.height, 1), 0), 1);

    event.currentTarget.style.setProperty("--panel-x", `${(x * 100).toFixed(2)}%`);
    event.currentTarget.style.setProperty("--panel-y", `${(y * 100).toFixed(2)}%`);
  }

  return (
    <div className="home-dashboard landing-view-next">
      <section
        ref={heroRef}
        className="home-cinematic-hero"
        aria-label={t(homeText.heroAria)}
        onPointerMove={handleCinematicPointerMove}
      >
        <div className="home-cinematic-copy">
          <p>Workflow Studio</p>
          <h2>{t(homeText.headline)}</h2>
          <span>{t(homeText.subtitle)}</span>
          <Link className="cinematic-start-action" href="/workflows">
            {t(homeText.start)}
          </Link>
        </div>

        <div className="home-prism-stage" aria-hidden="true">
          <div className="home-prism-beam" />
          <div className="home-prism-panel home-prism-panel-deep" onPointerMove={handlePrismPanelPointerMove} />
          <div className="home-prism-panel home-prism-panel-back" onPointerMove={handlePrismPanelPointerMove} />
          <div className="home-prism-panel home-prism-panel-mid" onPointerMove={handlePrismPanelPointerMove} />
          <div className="home-prism-panel home-prism-panel-front" onPointerMove={handlePrismPanelPointerMove} />
          <div className="home-prism-panel home-prism-panel-low" onPointerMove={handlePrismPanelPointerMove} />
          <div className="home-prism-panel home-prism-panel-side" onPointerMove={handlePrismPanelPointerMove} />
        </div>
      </section>

      <section className="landing-footer-panel-next" aria-label={t(homeText.footerAria)}>
        <p className="footer-disclaimer-next">
          {t(homeText.disclaimer)}
        </p>
        <div className="footer-main-next">
          <div className="footer-identity-next">
            <div className="footer-brand-next">
              <BrandMark aria-hidden="true" />
              <span>Workflow Studio</span>
            </div>
            <div className="footer-copyright-next">
              <span>{t(homeText.copyright)}</span>
              <span>{t(homeText.rights)}</span>
            </div>
          </div>
          <nav className="footer-legal-links-next" aria-label={t(homeText.legalAria)}>
            <button type="button" onClick={() => setActivePolicy("terms")}>
              {t(homeText.terms)}
            </button>
            <button type="button" onClick={() => setActivePolicy("privacy")}>
              {t(homeText.privacy)}
            </button>
          </nav>
        </div>
      </section>

      {policyMeta && (
        <div className="policy-dialog-backdrop" role="presentation" onMouseDown={() => setActivePolicy(null)}>
          <section
            className="policy-dialog policy-dialog-document"
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-policy-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="policy-dialog-head">
              <div>
                <p>{t(homeText.beta)}</p>
                <h2 id="home-policy-dialog-title">{t(homeText.policyTitle[activePolicy]) || policyMeta.dialogTitle}</h2>
              </div>
              <button className="policy-dialog-close" type="button" aria-label={t(homeText.closeDialog)} onClick={() => setActivePolicy(null)}>
                X
              </button>
            </header>
            <div className="policy-dialog-scroll" tabIndex={0}>
              <LegalDocument type={activePolicy} embedded />
            </div>
            <div className="policy-dialog-actions">
              <button type="button" onClick={() => setActivePolicy(null)}>
                {t(homeText.close)}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

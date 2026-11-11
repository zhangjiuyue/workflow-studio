"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { STATIC_UI_EN_PATTERNS, STATIC_UI_EN_TRANSLATIONS } from "./staticUiTranslations";

export const LANGUAGE_STORAGE_KEY = "flowstudio-language";
export const DEFAULT_LANGUAGE = "zh";

const LanguageContext = createContext({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  toggleLanguage: () => {},
  t: (value) => localizedText(value, DEFAULT_LANGUAGE),
});
const staticTranslationRoutes = ["/create", "/workflows", "/assets", "/admin", "/settings/api"];
const translatedTextNodes = new Map();
const translatedAttributes = new Map();
const translatedAttributeNames = ["placeholder", "aria-label", "title"];
const staticUiPhraseTranslations = Object.entries(STATIC_UI_EN_TRANSLATIONS)
  .filter(([source]) => /[\u4e00-\u9fff]/.test(source) && (source.length >= 4 || /[，。？！：、/]/.test(source) || /\d/.test(source)))
  .sort(([a], [b]) => b.length - a.length);

export function normalizeLanguage(value) {
  return value === "en" ? "en" : DEFAULT_LANGUAGE;
}

export function localizedText(value, language = DEFAULT_LANGUAGE) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value[language] ?? value.zh ?? value.en ?? "";
}

export function LanguageProvider({ children }) {
  const pathname = usePathname();
  const [language, setLanguageState] = useState(DEFAULT_LANGUAGE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setLanguageState(normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)));
    } catch {
      setLanguageState(DEFAULT_LANGUAGE);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const loginRoute = pathname === "/" || pathname?.startsWith("/login");
    document.documentElement.lang = loginRoute || language === "en" ? "en" : "zh-CN";
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Language preference is still usable for the current session.
    }
  }, [hydrated, language, pathname]);

  useEffect(() => {
    if (!hydrated) return undefined;
    const shouldTranslateStaticUi = language === "en" && staticTranslationRoutes.some((route) => pathname?.startsWith(route));

    if (!shouldTranslateStaticUi) {
      restoreStaticUiTranslations();
      return undefined;
    }

    let queued = false;
    function run() {
      queued = false;
      translateStaticUi(document.body);
    }
    function queueRun() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(run);
    }

    queueRun();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList" || mutation.type === "characterData" || mutation.type === "attributes") {
          queueRun();
          break;
        }
      }
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: translatedAttributeNames,
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [hydrated, language, pathname]);

  const value = useMemo(() => {
    function setLanguage(nextLanguage) {
      setLanguageState((currentLanguage) =>
        normalizeLanguage(typeof nextLanguage === "function" ? nextLanguage(currentLanguage) : nextLanguage)
      );
    }

    return {
      language,
      setLanguage,
      toggleLanguage: () => setLanguage((currentLanguage) => (currentLanguage === "en" ? "zh" : "en")),
      t: (text) => localizedText(text, language),
    };
  }, [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}

function translateStaticUi(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (isSkippableTranslationNode(node.parentElement)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach(translateTextNode);

  root.querySelectorAll?.("[placeholder], [aria-label], [title]").forEach(translateElementAttributes);
}

function translateTextNode(node) {
  const original = translatedTextNodes.get(node) || node.nodeValue;
  const translated = translateStaticValue(original);
  if (!translated || translated === node.nodeValue) return;
  translatedTextNodes.set(node, original);
  node.nodeValue = translated;
}

function translateElementAttributes(element) {
  if (isSkippableTranslationAttributeElement(element)) return;
  const originals = translatedAttributes.get(element) || {};
  let changed = false;
  for (const attribute of translatedAttributeNames) {
    if (!element.hasAttribute(attribute)) continue;
    const current = element.getAttribute(attribute);
    const original = originals[attribute] || current;
    const translated = translateStaticValue(original);
    if (!translated || translated === current) continue;
    originals[attribute] = original;
    element.setAttribute(attribute, translated);
    changed = true;
  }
  if (changed) translatedAttributes.set(element, originals);
}

function restoreStaticUiTranslations() {
  for (const [node, original] of translatedTextNodes) {
    if (node.isConnected) node.nodeValue = original;
  }
  translatedTextNodes.clear();

  for (const [element, originals] of translatedAttributes) {
    if (!element.isConnected) continue;
    for (const [attribute, original] of Object.entries(originals)) {
      element.setAttribute(attribute, original);
    }
  }
  translatedAttributes.clear();
}

function translateStaticValue(value) {
  if (!value || !/[\u4e00-\u9fff]/.test(value)) return "";
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  const core = value.trim().replace(/\s+/g, " ");
  const exact = STATIC_UI_EN_TRANSLATIONS[core];
  if (exact) return `${leading}${exact}${trailing}`;

  for (const [pattern, replacement] of STATIC_UI_EN_PATTERNS) {
    if (pattern.test(core)) return `${leading}${core.replace(pattern, replacement)}${trailing}`;
  }
  const phraseTranslated = translateStaticPhrases(core);
  if (phraseTranslated !== core && !/[\u4e00-\u9fff]/.test(phraseTranslated)) return `${leading}${phraseTranslated}${trailing}`;
  return "";
}

function translateStaticPhrases(value) {
  let translated = value;
  for (const [source, replacement] of staticUiPhraseTranslations) {
    if (translated.includes(source)) translated = translated.split(source).join(replacement);
  }
  return translated;
}

function isSkippableTranslationNode(element) {
  return !element || isSkippableTranslationElement(element);
}

function isSkippableTranslationElement(element) {
  if (!element) return true;
  return Boolean(element.closest("script, style, noscript, textarea, code, pre, [contenteditable='true'], [data-static-i18n='off']"));
}

function isSkippableTranslationAttributeElement(element) {
  if (!element) return true;
  return Boolean(element.closest("script, style, noscript, code, pre, [contenteditable='true'], [data-static-i18n='off']"));
}

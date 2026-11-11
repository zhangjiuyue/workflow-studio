"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "../../components/BrandLogo";
import { LEGAL_DOCUMENT_META, LegalDocument } from "../legal-documents";
import { requestFlowStudioApi, persistAuthSession, readStoredAuthUser } from "../../lib/flowstudio-api";

function FieldIcon({ type }) {
  const commonProps = {
    className: "field-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": "true",
  };

  if (type === "user") {
    return (
      <svg {...commonProps}>
        <path d="M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2Z" />
        <path d="M4.8 20c.8-3.4 3.2-5.2 7.2-5.2s6.4 1.8 7.2 5.2" />
      </svg>
    );
  }

  if (type === "lock") {
    return (
      <svg {...commonProps}>
        <path d="M7.6 10V8.2a4.4 4.4 0 0 1 8.8 0V10" />
        <path d="M6.8 10h10.4c.9 0 1.5.6 1.5 1.5v6.1c0 .9-.6 1.5-1.5 1.5H6.8c-.9 0-1.5-.6-1.5-1.5v-6.1c0-.9.6-1.5 1.5-1.5Z" />
        <path d="M12 14v2" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <path d="M5.5 7h13c.9 0 1.5.6 1.5 1.5v7c0 .9-.6 1.5-1.5 1.5h-13c-.9 0-1.5-.6-1.5-1.5v-7C4 7.6 4.6 7 5.5 7Z" />
      <path d="m5 8.2 7 5 7-5" />
    </svg>
  );
}

function VisibilityIcon() {
  return (
    <svg className="visibility-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M3.7 12s2.9-5 8.3-5 8.3 5 8.3 5-2.9 5-8.3 5-8.3-5-8.3-5Z" />
      <path d="M12 14.7a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4Z" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [storedUser, setStoredUser] = useState(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [activePolicy, setActivePolicy] = useState(null);

  const isRegister = mode === "register";
  const registerConsentMissing = isRegister && (!acceptedTerms || !acceptedPrivacy);
  const policyMeta = activePolicy ? LEGAL_DOCUMENT_META[activePolicy] : null;

  useEffect(() => {
    setStoredUser(readStoredAuthUser());
  }, []);

  useEffect(() => {
    if (!activePolicy) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") setActivePolicy(null);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activePolicy]);

  function switchMode(nextMode) {
    setMode(nextMode);
    setMessageType("");
    setMessage("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (registerConsentMissing) {
      setMessageType("error");
      setMessage("Please read and accept the agreements first.");
      return;
    }
    setIsSubmitting(true);
    setMessageType("");
    setMessage(isRegister ? "Submitting request..." : "Signing in...");
    try {
      const result = await requestFlowStudioApi(isRegister ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify(isRegister ? { email, password, displayName } : { email, password }),
      });
      if (isRegister) {
        setMode("login");
        setMessageType("success");
        setMessage("Request submitted. We will review your account shortly.");
        return;
      }
      persistAuthSession(result);
      setStoredUser(result.user);
      setMessageType("success");
      setMessage("Signed in. Opening workspace...");
      router.replace("/home");
    } catch (error) {
      setMessageType("error");
      setMessage(error.message || "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-backdrop" aria-hidden="true">
        <div className="auth-frame auth-frame-one">
          <i>00:00:00:00</i>
          <div className="auth-frame-media media-gate" />
        </div>
        <div className="auth-frame auth-frame-two">
          <i>00:00:08:12</i>
          <div className="auth-frame-media media-valley" />
        </div>
        <div className="auth-frame auth-frame-three">
          <i>00:00:15:20</i>
          <div className="auth-frame-media media-forest" />
        </div>
        <div className="auth-scanline" />
        <div className="auth-timeline">
          <div className="timeline-ruler" />
          <div className="timeline-playhead" />
          <div className="timeline-waveform">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>

      <header className="auth-page-brand" aria-label="Workflow Studio">
        <BrandMark aria-hidden="true" />
        <div>
          <strong>Workflow Studio</strong>
          <p>AI Video Workflow Platform</p>
        </div>
      </header>

      <section className="auth-card" aria-label={isRegister ? "Workflow Studio beta request" : "Workflow Studio sign in"}>
        <div className="auth-panel-head">
          <p>Private Beta</p>
          <h1>{isRegister ? "Request Access" : "Workflow Studio"}</h1>
          {isRegister && <span>We will review your account shortly after submission.</span>}
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isRegister && (
            <div className="auth-field">
              <label className="sr-only" htmlFor="auth-display-name">Display name</label>
              <FieldIcon type="user" />
              <input
                id="auth-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                placeholder="Display name"
              />
            </div>
          )}

          <div className="auth-field">
            <label className="sr-only" htmlFor="auth-email">Email</label>
            <FieldIcon type="mail" />
            <input
              id="auth-email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              autoComplete="email"
              placeholder="Email"
              required
            />
          </div>

          <div className="auth-field">
            <label className="sr-only" htmlFor="auth-password">Password</label>
            <FieldIcon type="lock" />
            <input
              id="auth-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={passwordVisible ? "text" : "password"}
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder="Password"
              required
            />
            <button
              className="field-visibility"
              type="button"
              aria-label={passwordVisible ? "Hide password" : "Show password"}
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible((current) => !current)}
            >
              <VisibilityIcon />
            </button>
          </div>

          {isRegister && (
            <div className="auth-consent-panel">
              <div className="auth-consent-row">
                <input
                  id="auth-terms-consent"
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(event) => setAcceptedTerms(event.target.checked)}
                  aria-label="I accept the User Agreement"
                  required
                />
                <span>
                  I accept the{" "}
                  <button className="policy-link-button" type="button" onClick={() => setActivePolicy("terms")}>
                    User Agreement
                  </button>
                </span>
              </div>
              <div className="auth-consent-row">
                <input
                  id="auth-privacy-consent"
                  type="checkbox"
                  checked={acceptedPrivacy}
                  onChange={(event) => setAcceptedPrivacy(event.target.checked)}
                  aria-label="I accept the Privacy Policy"
                  required
                />
                <span>
                  I accept the{" "}
                  <button className="policy-link-button" type="button" onClick={() => setActivePolicy("privacy")}>
                    Privacy Policy
                  </button>
                </span>
              </div>
            </div>
          )}

          {message && <p className={`auth-message ${messageType}`.trim()}>{message}</p>}

          <button className="primary-action" type="submit" disabled={isSubmitting || registerConsentMissing}>
            {isSubmitting ? "Processing..." : isRegister ? "Submit Request" : "Sign In"}
          </button>
        </form>

        <button className="auth-secondary-action" type="button" onClick={() => switchMode(isRegister ? "login" : "register")}>
          {isRegister ? "Back to Sign In" : "Request Access"}
          <span aria-hidden="true">→</span>
        </button>

        {storedUser && (
          <aside className="session-card">
            <span>Saved session</span>
            <strong>{storedUser.displayName || storedUser.email}</strong>
          </aside>
        )}
      </section>

      {policyMeta && (
        <div className="policy-dialog-backdrop" role="presentation" onMouseDown={() => setActivePolicy(null)}>
          <section
            className="policy-dialog policy-dialog-document"
            role="dialog"
            aria-modal="true"
            aria-labelledby="policy-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="policy-dialog-head">
              <div>
                <p>Private Beta</p>
                <h2 id="policy-dialog-title">{policyMeta.dialogTitle}</h2>
              </div>
              <button className="policy-dialog-close" type="button" aria-label="Close dialog" onClick={() => setActivePolicy(null)}>
                X
              </button>
            </header>
            <div className="policy-dialog-scroll" tabIndex={0}>
              <LegalDocument type={activePolicy} embedded />
            </div>
            <div className="policy-dialog-actions">
              <button type="button" onClick={() => setActivePolicy(null)}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

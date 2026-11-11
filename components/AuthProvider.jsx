"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTH_SESSION_CLEARED_EVENT,
  AUTH_SESSION_UPDATED_EVENT,
  clearAuthSession,
  persistAuthenticatedUser,
  readAuthToken,
  readStoredAuthUser,
  requestAuthedFlowStudioApi,
} from "../lib/flowstudio-api";

const AuthContext = createContext(null);
const SESSION_CHECK_INTERVAL_MS = 60 * 1000;

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(null);
  const [sessionState, setSessionState] = useState("checking");
  const [sessionMessageText, setSessionMessageText] = useState("");
  const userRef = useRef(null);
  const verificationIdRef = useRef(0);

  const setUser = useCallback((nextUser) => {
    userRef.current = nextUser;
    setUserState(nextUser);
  }, []);

  const verifySession = useCallback(async ({ background = false } = {}) => {
    const verificationId = ++verificationIdRef.current;
    const token = readAuthToken();
    if (!token) {
      setUser(null);
      setSessionState("signed-out");
      setSessionMessageText("");
      return;
    }

    if (!background) {
      setSessionState("checking");
      setSessionMessageText("");
    }

    try {
      const result = await requestAuthedFlowStudioApi("/api/auth/me");
      if (verificationId !== verificationIdRef.current) return;
      const verifiedUser = result?.user;
      if (!verifiedUser) {
        clearAuthSession();
        return;
      }
      persistAuthenticatedUser(verifiedUser);
      setUser(verifiedUser);
      setSessionState("ready");
      setSessionMessageText("");
    } catch (error) {
      if (verificationId !== verificationIdRef.current) return;
      if (error?.status === 401) {
        setUser(null);
        setSessionState("signed-out");
        setSessionMessageText("");
        return;
      }
      if (background && userRef.current) return;
      setSessionState("warning");
      setSessionMessageText(error.message || "登录状态确认失败。");
    }
  }, [setUser]);

  useEffect(() => {
    function handleAuthCleared() {
      verificationIdRef.current += 1;
      setUser(null);
      setSessionState("signed-out");
      setSessionMessageText("");
    }

    function handleAuthUpdated() {
      const cachedUser = readStoredAuthUser();
      if (cachedUser) setUser(cachedUser);
      verifySession();
    }

    window.addEventListener(AUTH_SESSION_CLEARED_EVENT, handleAuthCleared);
    window.addEventListener(AUTH_SESSION_UPDATED_EVENT, handleAuthUpdated);

    const cachedUser = readStoredAuthUser();
    if (cachedUser) setUser(cachedUser);
    verifySession();

    const intervalId = window.setInterval(() => verifySession({ background: true }), SESSION_CHECK_INTERVAL_MS);
    return () => {
      verificationIdRef.current += 1;
      window.clearInterval(intervalId);
      window.removeEventListener(AUTH_SESSION_CLEARED_EVENT, handleAuthCleared);
      window.removeEventListener(AUTH_SESSION_UPDATED_EVENT, handleAuthUpdated);
    };
  }, [setUser, verifySession]);

  const value = useMemo(() => ({ user, sessionState, sessionMessageText }), [sessionMessageText, sessionState, user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}

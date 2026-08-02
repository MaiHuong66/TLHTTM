import { createContext, use, useCallback, useState } from "react";
import type { ReactNode } from "react";
import { teacherLogin } from "../lib/api";

interface TeacherAuthContextValue {
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const TeacherAuthContext = createContext<TeacherAuthContextValue | null>(null);

const STORAGE_KEY = "tlhttm-teacher-token";

export function TeacherAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));

  const login = useCallback(async (username: string, password: string) => {
    const { token: newToken } = await teacherLogin(username, password);
    sessionStorage.setItem(STORAGE_KEY, newToken);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
  }, []);

  return <TeacherAuthContext value={{ token, login, logout }}>{children}</TeacherAuthContext>;
}

export function useTeacherAuth(): TeacherAuthContextValue {
  const ctx = use(TeacherAuthContext);
  if (!ctx) throw new Error("useTeacherAuth must be used within TeacherAuthProvider");
  return ctx;
}

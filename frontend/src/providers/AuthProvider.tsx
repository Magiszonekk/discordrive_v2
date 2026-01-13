"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { User } from "@/types";
import * as api from "@/lib/api";
import { clearAuthToken, getAuthToken, setAuthToken } from "@/lib/auth-storage";
import { clearAllFilePasswords } from "@/lib/password-store";
import { toast } from "sonner";
import {
  getStoredKey,
  saveCryptoPrefs,
  getStoredMethod,
  decryptKeyWithPassword,
  setKeySyncEnabled,
} from "@/lib/crypto-client";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (params: { username: string; email: string; password: string }) => Promise<void>;
  logout: () => void;
  requestPasswordReset: (email: string) => Promise<void>;
  confirmPasswordReset: (token: string, password: string) => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const refreshUser = useCallback(async () => {
    const token = getAuthToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const res = await api.fetchCurrentUser();
      setUser(res.user);

      // Check if encryption key needs to be restored from cloud
      const localKey = getStoredKey();
      if (!localKey) {
        // No local key - check if cloud sync is enabled
        try {
          const keyResponse = await api.getEncryptedKey();
          if (keyResponse.hasKey && keyResponse.keySyncEnabled) {
            // Cloud key exists but no local key - force re-login to restore it
            clearAuthToken();
            setUser(null);
            toast.info("Zaloguj się ponownie aby przywrócić klucz szyfrowania na tym urządzeniu");
          }
        } catch {
          // Ignore errors checking key status
        }
      }
    } catch {
      clearAuthToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.loginUser({ email, password });
      setAuthToken(res.token);
      setUser(res.user);

      // Auto-fetch encrypted key from server
      try {
        const keyResponse = await api.getEncryptedKey();
        if (
          keyResponse.hasKey &&
          keyResponse.keySyncEnabled &&
          keyResponse.encryptedKey &&
          keyResponse.salt
        ) {
          // Check if local key already exists
          const localKey = getStoredKey();
          if (!localKey) {
            // Decrypt and save key locally
            try {
              const decryptedKey = await decryptKeyWithPassword(
                keyResponse.encryptedKey,
                keyResponse.salt,
                password
              );
              saveCryptoPrefs(decryptedKey, getStoredMethod());
              setKeySyncEnabled(true);
              toast.success("Klucz szyfrowania przywrócony z chmury");
            } catch (decryptError) {
              console.error("Failed to decrypt key:", decryptError);
              toast.error("Nie udało się przywrócić klucza szyfrowania. Może być konieczne ponowne wprowadzenie.");
            }
          } else {
            // Local key exists, just update sync preference
            setKeySyncEnabled(true);
          }
        }
      } catch {
        // Ignore key fetch errors during login
      }

      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      toast.success("Logged in");
      return res.user;
    },
    [queryClient]
  );

  const register = useCallback(async (params: { username: string; email: string; password: string }) => {
    await api.registerUser(params);
    toast.success("Registered. Check your email to verify the account.");
  }, []);

  const logout = useCallback(() => {
    clearAuthToken();
    setUser(null);
    clearAllFilePasswords();
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["folders"] });
    toast.success("Logged out");
  }, [queryClient]);

  const requestPasswordReset = useCallback(async (email: string) => {
    await api.requestPasswordReset(email);
    toast.success("If the account exists, an email was sent.");
  }, []);

  const confirmPasswordReset = useCallback(async (token: string, password: string) => {
    await api.confirmPasswordReset(token, password);
    toast.success("Password updated. You can log in now.");
  }, []);

  const value: AuthContextValue = {
    user,
    loading,
    login,
    register,
    logout,
    requestPasswordReset,
    confirmPasswordReset,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

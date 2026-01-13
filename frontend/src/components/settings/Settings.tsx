"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { getDebugPreference, setDebugPreference } from "@/lib/debug-prefs";
import { Cloud, CloudOff, Loader2, Lock, Settings2, Eye, EyeOff, Copy, Check } from "lucide-react";
import { useAuth } from "@/providers/AuthProvider";
import * as api from "@/lib/api";
import {
  saveCryptoPrefs,
  getStoredKey,
  getStoredMethod,
  CryptoMethod,
  getStoredWorkerCount,
  getDefaultWorkerCount,
  saveWorkerCountPreference,
  MAX_WORKER_COUNT,
  MIN_WORKER_COUNT,
  encryptKeyWithPassword,
  getKeySyncEnabled,
  setKeySyncEnabled,
} from "@/lib/crypto-client";

export function Settings() {
  const { user } = useAuth();

  // Encryption state
  const [key, setKey] = useState(() => getStoredKey() || "");
  const [method, setMethod] = useState<CryptoMethod>(() => getStoredMethod());
  const [workerCount, setWorkerCount] = useState<string>(() => String(getStoredWorkerCount()));
  const [detectedCores] = useState<number | null>(() =>
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency || null
      : null
  );

  // General state
  const [showDebug, setShowDebug] = useState<boolean>(() => getDebugPreference());

  // Save state
  const [saved, setSaved] = useState(false);

  // Key visibility state
  const [showKey, setShowKey] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

  // Key sync state
  const [keySyncEnabled, setKeySyncEnabledLocal] = useState<boolean>(() => getKeySyncEnabled());
  const [serverHasKey, setServerHasKey] = useState<boolean>(false);
  const [syncLoading, setSyncLoading] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [passwordForSync, setPasswordForSync] = useState<string>("");
  const [showPasswordDialog, setShowPasswordDialog] = useState<boolean>(false);
  const [pendingSyncAction, setPendingSyncAction] = useState<"enable" | "disable" | null>(null);

  // Check server key status on mount (if logged in)
  useEffect(() => {
    if (user) {
      checkServerKeyStatus();
    }
  }, [user]);

  async function checkServerKeyStatus() {
    try {
      const response = await api.getEncryptedKey();
      setServerHasKey(response.hasKey);
      setKeySyncEnabledLocal(response.keySyncEnabled);
      setKeySyncEnabled(response.keySyncEnabled);
    } catch {
      // Ignore errors
    }
  }

  async function handleEnableSync() {
    const currentKey = getStoredKey();
    if (!currentKey) {
      setSyncError("Brak klucza do synchronizacji. Najpierw wygeneruj lub wprowadź klucz.");
      return;
    }
    setShowPasswordDialog(true);
    setPendingSyncAction("enable");
    setSyncError(null);
  }

  async function handleDisableSync() {
    setShowPasswordDialog(true);
    setPendingSyncAction("disable");
    setSyncError(null);
  }

  async function handleSyncWithPassword() {
    if (!passwordForSync.trim()) {
      setSyncError("Hasło jest wymagane");
      return;
    }

    setSyncLoading(true);
    setSyncError(null);

    try {
      // First verify the password is correct
      try {
        await api.verifyPassword(passwordForSync);
      } catch {
        setSyncError("Nieprawidłowe hasło");
        setSyncLoading(false);
        return;
      }

      if (pendingSyncAction === "enable") {
        const currentKey = getStoredKey();
        if (!currentKey) throw new Error("Brak klucza do synchronizacji");

        // Encrypt key with password
        const { encryptedKey, salt } = await encryptKeyWithPassword(currentKey, passwordForSync);

        // Save to server
        await api.saveEncryptedKey({ encryptedKey, salt, enabled: true });

        setKeySyncEnabledLocal(true);
        setKeySyncEnabled(true);
        setServerHasKey(true);
      } else {
        // Disable sync - delete from server
        await api.deleteEncryptedKey();

        setKeySyncEnabledLocal(false);
        setKeySyncEnabled(false);
        setServerHasKey(false);
      }

      setShowPasswordDialog(false);
      setPasswordForSync("");
      setPendingSyncAction(null);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Synchronizacja nieudana");
    } finally {
      setSyncLoading(false);
    }
  }

  const generateKey = () => {
    const bytes = new Uint8Array(32);
    (crypto || window.crypto).getRandomValues(bytes);
    const generated = btoa(String.fromCharCode(...bytes));
    setKey(generated);
    setSaved(false);
  };

  // Generate a short fingerprint of the key for easy comparison
  const getKeyFingerprint = (keyStr: string): string => {
    if (!keyStr) return "—";
    // Simple hash: sum of char codes mod 65536, formatted as hex
    let hash = 0;
    for (let i = 0; i < keyStr.length; i++) {
      hash = ((hash << 5) - hash + keyStr.charCodeAt(i)) | 0;
    }
    const hex = ((hash >>> 0) & 0xFFFFFFFF).toString(16).toUpperCase().padStart(8, "0");
    return `${hex.slice(0, 4)}-${hex.slice(4)}`;
  };

  const copyKeyToClipboard = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = key;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    }
  };

  const handleSave = () => {
    if (!key.trim()) {
      setSaved(false);
      return;
    }
    const parsedWorkers = parseInt(workerCount, 10);
    const normalizedWorkers = saveWorkerCountPreference(
      Number.isFinite(parsedWorkers) ? parsedWorkers : getDefaultWorkerCount()
    );
    saveCryptoPrefs(key.trim(), method);
    setWorkerCount(String(normalizedWorkers));
    setDebugPreference(showDebug);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Tabs defaultValue="general" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="general" className="flex items-center gap-2">
          <Settings2 className="h-4 w-4" />
          General
        </TabsTrigger>
        <TabsTrigger value="encryption" className="flex items-center gap-2">
          <Lock className="h-4 w-4" />
          Encryption
        </TabsTrigger>
      </TabsList>

      {/* Encryption Tab */}
      <TabsContent value="encryption" className="space-y-4 mt-4">
        <div className="space-y-1.5">
          <Label htmlFor="enc-method">Method</Label>
          <select
            id="enc-method"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={method}
            onChange={(e) => setMethod(e.target.value as CryptoMethod)}
          >
            <option value="chunked-aes-gcm-12-fast">Fast (50k PBKDF2) — najszybsze</option>
            <option value="chunked-aes-gcm-12">Balanced (100k PBKDF2) — domyślne</option>
            <option value="chunked-aes-gcm-16">Strong (150k PBKDF2) — mocniejsze</option>
            <option value="chunked-aes-gcm-16-strong">Max (300k PBKDF2) — najsilniejsze</option>
          </select>
          <p className="text-xs text-muted-foreground">
            Kompromis prędkość/siła. Zmiana dotyczy nowych uploadów.
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="enc-key">Encryption key</Label>
            {key && (
              <span className="text-xs font-mono text-muted-foreground">
                Fingerprint: <span className="text-foreground">{getKeyFingerprint(key)}</span>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="enc-key"
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Enter your key"
                className="h-9 pr-20 font-mono text-sm"
              />
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? "Ukryj klucz" : "Pokaż klucz"}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={copyKeyToClipboard}
                  disabled={!key}
                  title="Kopiuj klucz"
                >
                  {keyCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={generateKey}>
              Generate
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Klucz przechowywany w localStorage przeglądarki. Porównaj Fingerprint aby sprawdzić czy klucz jest taki sam na różnych urządzeniach.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="worker-count">Worker count</Label>
          <Input
            id="worker-count"
            type="number"
            inputMode="numeric"
            min={MIN_WORKER_COUNT}
            max={MAX_WORKER_COUNT}
            value={workerCount}
            onChange={(e) => {
              setWorkerCount(e.target.value);
              setSaved(false);
            }}
            className="h-9"
          />
          <p className="text-xs text-muted-foreground">
            Wykryto {detectedCores ?? "?"} rdzeni. Domyślnie {getDefaultWorkerCount()} workerów (max {MAX_WORKER_COUNT}).
          </p>
        </div>

        {/* Cloud Key Backup - only for logged in users */}
        {user && (
          <div className="space-y-2 border rounded-md p-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  {keySyncEnabled ? (
                    <Cloud className="h-4 w-4 text-green-500" />
                  ) : (
                    <CloudOff className="h-4 w-4 text-muted-foreground" />
                  )}
                  <p className="text-sm font-medium">Cloud Key Backup</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {keySyncEnabled
                    ? "Klucz zsynchronizowany z serwerem"
                    : "Tylko w tej przeglądarce"}
                </p>
              </div>
              <Button
                variant={keySyncEnabled ? "destructive" : "secondary"}
                size="sm"
                onClick={keySyncEnabled ? handleDisableSync : handleEnableSync}
                disabled={syncLoading || !key.trim()}
              >
                {syncLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {keySyncEnabled ? "Wyłącz" : "Włącz"}
              </Button>
            </div>
            {syncError && <p className="text-xs text-destructive">{syncError}</p>}
            <p className="text-xs text-muted-foreground">
              Klucz zostanie zaszyfrowany hasłem do konta (AES-256-GCM) przed zapisaniem na serwerze.
            </p>

            {showPasswordDialog && (
              <div className="mt-3 p-3 border rounded-md bg-muted/50 space-y-2">
                <p className="text-sm font-medium">
                  {pendingSyncAction === "enable"
                    ? "Wprowadź hasło do konta"
                    : "Potwierdź usunięcie"}
                </p>
                <Input
                  type="password"
                  placeholder="Hasło do konta"
                  value={passwordForSync}
                  onChange={(e) => setPasswordForSync(e.target.value)}
                  className="h-9"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSyncWithPassword();
                  }}
                />
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowPasswordDialog(false);
                      setPasswordForSync("");
                      setPendingSyncAction(null);
                      setSyncError(null);
                    }}
                    disabled={syncLoading}
                  >
                    Anuluj
                  </Button>
                  <Button size="sm" onClick={handleSyncWithPassword} disabled={syncLoading}>
                    {syncLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {pendingSyncAction === "enable" ? "Zapisz" : "Usuń"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </TabsContent>

      {/* General Tab */}
      <TabsContent value="general" className="space-y-4 mt-4">
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Dev info</p>
            <p className="text-xs text-muted-foreground">Pokaż metryki botów i bufora podczas uploadu.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowDebug((v) => !v);
              setSaved(false);
            }}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
              showDebug ? "bg-primary" : "bg-muted"
            )}
            aria-pressed={showDebug}
            aria-label="Toggle dev info"
          >
            <span
              className={cn(
                "inline-block h-5 w-5 rounded-full bg-background shadow transform transition-transform",
                showDebug ? "translate-x-5" : "translate-x-1"
              )}
            />
          </button>
        </div>

        <div className="text-xs text-muted-foreground p-3 border rounded-md bg-muted/30">
          <p className="font-medium mb-1">Informacje</p>
          <ul className="space-y-1">
            <li>• Wszystkie ustawienia zapisywane w localStorage</li>
            <li>• Klucz szyfrowania nigdy nie opuszcza przeglądarki (chyba że włączysz Cloud Backup)</li>
            <li>• Pliki szyfrowane AES-256-GCM przed wysłaniem</li>
          </ul>
        </div>
      </TabsContent>

      {/* Save button - outside tabs */}
      <div className="flex justify-end mt-4 pt-4 border-t">
        <Button size="sm" onClick={handleSave}>
          {saved ? "Saved" : "Save"}
        </Button>
      </div>
    </Tabs>
  );
}

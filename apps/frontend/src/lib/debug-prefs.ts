"use client";

const STORAGE_DEBUG_KEY = "discordrive_debug_info";
const DEBUG_EVENT = "discordrive:debug-updated";

export function getDebugPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = localStorage.getItem(STORAGE_DEBUG_KEY);
    return stored === "true";
  } catch {
    return false;
  }
}

export function setDebugPreference(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_DEBUG_KEY, enabled ? "true" : "false");
  } catch {
    // ignore storage errors
  }
  window.dispatchEvent(new CustomEvent<boolean>(DEBUG_EVENT, { detail: enabled }));
}

export function subscribeDebugPreference(callback: (enabled: boolean) => void) {
  const handler = (event: Event) => {
    if (event instanceof CustomEvent && typeof event.detail === "boolean") {
      callback(event.detail);
    }
  };
  window.addEventListener(DEBUG_EVENT, handler);
  return () => window.removeEventListener(DEBUG_EVENT, handler);
}

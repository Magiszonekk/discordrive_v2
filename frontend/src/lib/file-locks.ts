"use client";

import { setFilePassword, clearFilePassword, getFilePassword } from "./password-store";
import { getFileInfo } from "./api";

export async function promptForFilePassword(fileId: number, reason?: string): Promise<string | null> {
  const cached = getFilePassword(fileId);
  if (cached) return cached;
  const input = window.prompt(reason || "Enter file password");
  if (input && input.trim().length > 0) {
    setFilePassword(fileId, input.trim());
    return input.trim();
  }
  return null;
}

export async function setFileLock(fileId: number): Promise<boolean> {
  const pwd = window.prompt("Set password for this file (cannot be empty):");
  if (!pwd || pwd.trim().length === 0) return false;
  setFilePassword(fileId, pwd.trim());
  return true;
}

export function removeFileLockFromCache(fileId: number) {
  clearFilePassword(fileId);
}

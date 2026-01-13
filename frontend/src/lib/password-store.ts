"use client";

const FILE_PASSWORD_KEY = "discordrive_file_passwords";

function readMap(key: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeMap(key: string, data: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function getFilePassword(fileId: number): string | undefined {
  const map = readMap(FILE_PASSWORD_KEY);
  return map[String(fileId)];
}

export function setFilePassword(fileId: number, password: string) {
  const map = readMap(FILE_PASSWORD_KEY);
  map[String(fileId)] = password;
  writeMap(FILE_PASSWORD_KEY, map);
}

export function clearFilePassword(fileId: number) {
  const map = readMap(FILE_PASSWORD_KEY);
  delete map[String(fileId)];
  writeMap(FILE_PASSWORD_KEY, map);
}

export function clearAllFilePasswords() {
  writeMap(FILE_PASSWORD_KEY, {});
}

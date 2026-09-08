// RECREATED — clean reimplementation of behavior observed in recovered dist/server.cjs.
// Data dir must be a writable per-user folder (install dir is read-only).
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR: string = process.env.MYRAA_DATA_DIR || process.cwd();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch { /* best-effort */ }

export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

export const SECRETS_FILE = dataFile('secrets.json');

type Secrets = { geminiApiKey?: string; ignoreEnvironmentApiKey?: boolean };

export function readSecrets(): Secrets {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8')) as Secrets;
    }
  } catch { /* corrupted -> treat as empty */ }
  return {};
}

export function getGeminiApiKey(): string | undefined {
  const stored = readSecrets().geminiApiKey?.trim();
  if (stored) return stored;
  if (readSecrets().ignoreEnvironmentApiKey) return undefined;
  return process.env.GEMINI_API_KEY?.trim() || undefined;
}

export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

export function setGeminiApiKey(key: string): void {
  const trimmed = (key || '').trim();
  if (!trimmed) throw new Error('API key must not be empty.');
  const current = readSecrets();
  current.geminiApiKey = trimmed;
  delete current.ignoreEnvironmentApiKey;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), 'utf-8');
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* windows */ }
}

export function clearGeminiApiKey(): void {
  const current = readSecrets();
  delete current.geminiApiKey;
  current.ignoreEnvironmentApiKey = true;
  try {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

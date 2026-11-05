import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual } from "./crypto";

// Cloudflare Workers' WebCrypto rejects PBKDF2 iteration counts above 100,000,
// so this is the platform ceiling as well as the current hashing work factor.
const ITERATIONS = 100_000;
const MIN_ITERATIONS = 10_000;
const MAX_ITERATIONS = 100_000;
const KEY_BYTES = 32;

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Store as `pbkdf2$<iterations>$<salt-b64url>$<hash-b64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    return false;
  }
  try {
    const salt = base64UrlToBytes(parts[2]);
    const expected = parts[3];
    const actual = bytesToBase64Url(await derive(password, salt, iterations));
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validatePassword(password: string): string | null {
  if (password.length < 10) return "password must be at least 10 characters";
  if (password.length > 200) return "password must be at most 200 characters";
  return null;
}

/** Generate a one-time password for admin-created users. */
export function temporaryPassword(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)));
}

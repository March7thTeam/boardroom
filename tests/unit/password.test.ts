import { describe, expect, it } from "vitest";
import {
  hashPassword,
  temporaryPassword,
  validatePassword,
  verifyPassword,
} from "../../src/lib/password";

describe("password hashing", () => {
  it("hashes and verifies a password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  it("stays within the Workers PBKDF2 iteration limit", async () => {
    const stored = await hashPassword("iteration check");
    const iterations = Number(stored.split("$")[1]);
    expect(Number.isInteger(iterations)).toBe(true);
    expect(iterations).toBeGreaterThanOrEqual(10_000);
    expect(iterations).toBeLessThanOrEqual(100_000);
  });

  it("uses a fresh salt per hash", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("rejects missing or malformed hashes", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$1$bad$bad")).toBe(false);
  });

  it("enforces the minimum password length", () => {
    expect(validatePassword("short")).toMatch(/10/);
    expect(validatePassword("long-enough-password")).toBeNull();
  });

  it("generates one-time passwords with enough entropy", () => {
    const a = temporaryPassword();
    const b = temporaryPassword();
    expect(a.length).toBeGreaterThanOrEqual(12);
    expect(a).not.toBe(b);
  });
});

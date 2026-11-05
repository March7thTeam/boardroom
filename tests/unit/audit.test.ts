import { describe, expect, it } from "vitest";
import { auditHash, verifyAuditChain, ZERO_HASH } from "../../src/domain/audit";
import type { AuditRow } from "../../src/types";

const entry = {
  projectId: "prj_1",
  seq: 1,
  eventType: "card.created",
  actorType: "user" as const,
  actorId: "usr_1",
  cardId: "c_1",
  payload: { after: { id: "c_1", title: "hello" } },
  createdAt: "2026-11-03T10:00:00.000Z",
};

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 1,
    project_id: "prj_1",
    seq: 1,
    event_type: "card.created",
    actor_type: "user",
    actor_id: "usr_1",
    card_id: "c_1",
    payload_json: JSON.stringify(entry.payload),
    prev_hash: ZERO_HASH,
    hash: "",
    batch_id: "ab_1",
    created_at: entry.createdAt,
    ...overrides,
  };
}

describe("audit chain", () => {
  it("is deterministic and key-order independent", async () => {
    const a = await auditHash(ZERO_HASH, entry);
    const b = await auditHash(ZERO_HASH, {
      ...entry,
      payload: { after: { title: "hello", id: "c_1" } },
    });
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("verifies a valid single-entry chain", async () => {
    const hash = await auditHash(ZERO_HASH, entry);
    const result = await verifyAuditChain([row({ hash })]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.head?.hash).toBe(hash);
  });

  it("detects a tampered payload", async () => {
    const hash = await auditHash(ZERO_HASH, entry);
    const result = await verifyAuditChain([
      row({ hash, payload_json: JSON.stringify({ after: { id: "c_1", title: "tampered" } }) }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("HASH_MISMATCH");
  });

  it("detects a broken prev_hash link", async () => {
    const hash = await auditHash(ZERO_HASH, entry);
    const result = await verifyAuditChain([
      row({ hash }),
      row({ id: 2, seq: 2, prev_hash: "sha256:deadbeef", hash: "sha256:deadbeef" }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "CHAIN_BREAK")).toBe(true);
  });

  it("detects a missing seq", async () => {
    const hash = await auditHash(ZERO_HASH, entry);
    const second = await auditHash(hash, { ...entry, seq: 2 });
    const result = await verifyAuditChain([
      row({ hash }),
      row({ id: 3, seq: 3, prev_hash: hash, hash: second }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "SEQ_GAP")).toBe(true);
  });
});

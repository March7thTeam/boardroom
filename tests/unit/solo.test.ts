import { describe, expect, it } from "vitest";
import {
  SELF_DEAL_COOLDOWN_MINUTES,
  classifySelfDeal,
  cooldownRemainingMs,
  surveyCounterparties,
  type CounterpartySurvey,
} from "../../src/domain/solo";

const now = Date.parse("2026-11-05T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const decide = (survey: CounterpartySurvey, cardCreatedAt: string, initiatorAgentId = "alpha:me") =>
  classifySelfDeal({ initiatorAgentId, actorId: "alpha:me", survey, cardCreatedAt, nowMs: now });

describe("classifySelfDeal", () => {
  it("leaves normal two-party negotiation alone", () => {
    const decision = classifySelfDeal({
      initiatorAgentId: "alpha:other",
      actorId: "alpha:me",
      survey: { active: 0, available: 0 },
      cardCreatedAt: minutesAgo(1),
      nowMs: now,
    });
    expect(decision.kind).toBe("counterparty");
  });

  it("allows self-deal immediately in a solo project (nobody to wait for)", () => {
    expect(decide({ active: 0, available: 0 }, minutesAgo(0))).toEqual({
      kind: "allowed",
      reason: "no_counterparty",
    });
  });

  it("blocks self-deal while another agent is online, regardless of card age", () => {
    expect(decide({ active: 1, available: 1 }, minutesAgo(120))).toEqual({
      kind: "blocked_online",
      available: 1,
    });
  });

  it("blocks self-deal during the cooldown when counterparties exist but are offline", () => {
    const decision = decide({ active: 2, available: 0 }, minutesAgo(3));
    expect(decision.kind).toBe("blocked_cooldown");
    if (decision.kind !== "blocked_cooldown") throw new Error("unreachable");
    expect(decision.cooldown_minutes).toBe(SELF_DEAL_COOLDOWN_MINUTES);
    expect(decision.retry_after_seconds).toBe((SELF_DEAL_COOLDOWN_MINUTES - 3) * 60);
  });

  it("opens self-deal once the cooldown has elapsed", () => {
    expect(decide({ active: 2, available: 0 }, minutesAgo(SELF_DEAL_COOLDOWN_MINUTES + 1))).toEqual({
      kind: "allowed",
      reason: "counterparties_offline",
    });
  });

  it("treats an unparsable card timestamp as not yet cooled down", () => {
    const decision = decide({ active: 1, available: 0 }, "not-a-date");
    expect(decision.kind).toBe("blocked_cooldown");
  });
});

describe("cooldownRemainingMs", () => {
  it("counts down and never goes negative", () => {
    expect(cooldownRemainingMs(minutesAgo(0), now)).toBe(SELF_DEAL_COOLDOWN_MINUTES * 60_000);
    expect(cooldownRemainingMs(minutesAgo(SELF_DEAL_COOLDOWN_MINUTES), now)).toBe(0);
    expect(cooldownRemainingMs(minutesAgo(60), now)).toBe(0);
  });
});

describe("surveyCounterparties", () => {
  const rows = (...results: Array<{ active: number; available: number }>) => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            calls.push({ sql, args });
            return { first: async () => results.shift() ?? { active: 0, available: 0 } };
          },
        };
      },
    } as unknown as D1Database;
    return { db, calls };
  };

  it("uses project membership authority and one supplied time for heartbeat and lease checks", async () => {
    const { db, calls } = rows({ active: 3, available: 1 });
    await expect(surveyCounterparties(db, "prj_1", "alpha:me", now)).resolves.toEqual({
      active: 3,
      available: 1,
    });

    const [{ sql, args }] = calls;
    expect(sql).toContain("ap.status = 'active'");
    expect(sql).toContain("ap.agent_id <> ?2");
    expect(sql).not.toContain("a.status");
    expect(sql).toContain("last_seen_at >= ?3");
    expect(sql).toContain("lease_expires_at > ?4");
    expect(args.slice(0, 2)).toEqual(["prj_1", "alpha:me"]);
    expect(args[2]).toBe(new Date(now - 20 * 60_000).toISOString());
    expect(args[3]).toBe(new Date(now).toISOString());
  });

  it("returns zeros when the query yields nothing", async () => {
    const { db } = rows();
    await expect(surveyCounterparties(db, "prj_1", "alpha:me", now)).resolves.toEqual({
      active: 0,
      available: 0,
    });
  });
});

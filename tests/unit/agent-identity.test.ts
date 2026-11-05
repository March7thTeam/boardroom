import { describe, expect, it } from "vitest";
import { allocateLocalSlug } from "../../src/domain/agent-projects";
import { formatScopedAgentRef, parseAgentToken, parseScopedAgentRef } from "../../src/lib/tokens";

const PROJECT_ID = "prj_01J9Z6ABCDEFGHJKMNPQRSTVWX";

describe("project-scoped agent refs", () => {
  it("parses <project_id>:<local_slug>", () => {
    expect(parseScopedAgentRef(`${PROJECT_ID}:bot`)).toEqual({ projectId: PROJECT_ID, localSlug: "bot" });
  });

  it("formats and re-parses", () => {
    expect(parseScopedAgentRef(formatScopedAgentRef(PROJECT_ID, "log-bot"))).toEqual({
      projectId: PROJECT_ID,
      localSlug: "log-bot",
    });
  });

  it("does not mistake legacy <projectSlug>:<agentSlug> for a scoped ref", () => {
    expect(parseScopedAgentRef("alpha:bot")).toBeNull();
  });

  it("rejects invalid local slugs", () => {
    expect(parseScopedAgentRef(`${PROJECT_ID}:Bot`)).toBeNull();
    expect(parseScopedAgentRef(`${PROJECT_ID}:`)).toBeNull();
  });

  it("rejects payload shapes that are not project-scoped refs", () => {
    const scoped = Buffer.from(`${PROJECT_ID}:bot`).toString("base64url");
    const legacy = Buffer.from("alpha:bot").toString("base64url");
    expect(parseAgentToken(`kbt1.${scoped}.secret`)).toEqual({ agentId: `${PROJECT_ID}:bot`, secret: "secret" });
    expect(parseAgentToken(`kbt1.${legacy}.secret`)).toBeNull();
    expect(parseAgentToken("kbt1.not-base64!!.secret")).toBeNull();
  });
});

describe("allocateLocalSlug", () => {
  it("keeps the base slug when free", () => {
    expect(allocateLocalSlug("bot", [])).toBe("bot");
  });

  it("suffixes on collision", () => {
    expect(allocateLocalSlug("bot", ["bot"])).toBe("bot-2");
    expect(allocateLocalSlug("bot", ["bot", "bot-2"])).toBe("bot-3");
  });

  it("normalizes unsafe characters", () => {
    expect(allocateLocalSlug("My Agent!", [])).toBe("my-agent");
    expect(allocateLocalSlug("--", [])).toBe("agent");
  });

  it("caps the length at 32 characters", () => {
    const slug = allocateLocalSlug("a".repeat(40), []);
    expect(slug).toHaveLength(32);
    const collided = allocateLocalSlug("a".repeat(40), [slug]);
    expect(collided.length).toBeLessThanOrEqual(32);
    expect(collided).not.toBe(slug);
  });
});

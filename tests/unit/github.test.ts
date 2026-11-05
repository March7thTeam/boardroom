import { describe, expect, it } from "vitest";
import { verifyGithubActionsRun } from "../../src/providers/github";
import type { Env } from "../../src/types";

const target = {
  owner: "acme",
  repo: "etl-jobs",
  workflow: "normalize.yml",
  ref: "main",
};

const issuedAt = "2026-11-04T10:00:00.000Z";

function env(token: string | undefined = "github-token"): Env {
  return { GITHUB_TOKEN: token } as Env;
}

function runResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 1234567890,
      run_attempt: 1,
      html_url: "https://github.com/acme/etl-jobs/actions/runs/1234567890",
      head_sha: "abc123",
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/normalize.yml",
      created_at: "2026-11-04T10:01:00.000Z",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("GitHub Actions verification", () => {
  it("accepts an allowed successful run created after the ticket", async () => {
    const result = await verifyGithubActionsRun(env(), {
      target,
      runUrl: "https://github.com/acme/etl-jobs/actions/runs/1234567890",
      runId: 1234567890,
      runAttempt: 1,
      issuedAt,
      fetchImpl: async () => runResponse(),
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe("ok");
    expect(result.run?.head_sha).toBe("abc123");
  });

  it("rejects a run from a different repository", async () => {
    const result = await verifyGithubActionsRun(env(), {
      target,
      runUrl: "https://github.com/other/etl-jobs/actions/runs/1234567890",
      runId: 1234567890,
      issuedAt,
      fetchImpl: async () => runResponse(),
    });
    expect(result.ok).toBe(false);
    expect(result.result).toBe("failed");
  });

  it("rejects a failed or old run", async () => {
    const failed = await verifyGithubActionsRun(env(), {
      target,
      runUrl: "https://github.com/acme/etl-jobs/actions/runs/1234567890",
      runId: 1234567890,
      issuedAt,
      fetchImpl: async () => runResponse({ conclusion: "failure" }),
    });
    expect(failed.ok).toBe(false);

    const old = await verifyGithubActionsRun(env(), {
      target,
      runUrl: "https://github.com/acme/etl-jobs/actions/runs/1234567890",
      runId: 1234567890,
      issuedAt,
      fetchImpl: async () => runResponse({ created_at: "2026-11-04T09:59:00.000Z" }),
    });
    expect(old.ok).toBe(false);
    expect(old.result).toBe("failed");
  });

  it("rejects a workflow outside the allow-list", async () => {
    const result = await verifyGithubActionsRun(env(), {
      target,
      runUrl: "https://github.com/acme/etl-jobs/actions/runs/1234567890",
      runId: 1234567890,
      issuedAt,
      fetchImpl: async () => runResponse({ path: ".github/workflows/deploy.yml" }),
    });
    expect(result.ok).toBe(false);
    expect(result.result).toBe("failed");
  });

  it("verifies the reported attempt after a newer rerun exists", async () => {
    let requestedUrl = "";
    const result = await verifyGithubActionsRun(env(), {
      target,
      runUrl: "https://github.com/acme/etl-jobs/actions/runs/1234567890/attempts/1",
      runId: 1234567890,
      runAttempt: 1,
      issuedAt,
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return requestedUrl.endsWith("/attempts/1")
          ? runResponse({ run_attempt: 1 })
          : runResponse({ run_attempt: 2, conclusion: "failure" });
      },
    });
    expect(result.ok).toBe(true);
    expect(result.run?.run_attempt).toBe(1);
    expect(requestedUrl).toBe(
      "https://api.github.com/repos/acme/etl-jobs/actions/runs/1234567890/attempts/1",
    );
  });

  it("uses an attempt encoded in the URL when no separate attempt is given", async () => {
    const result = await verifyGithubActionsRun(env(), {
      target,
      runUrl: "https://github.com/acme/etl-jobs/actions/runs/1234567890/attempts/1",
      runId: 1234567890,
      issuedAt,
      fetchImpl: async (url) =>
        String(url).endsWith("/attempts/1")
          ? runResponse({ run_attempt: 1, conclusion: "failure" })
          : runResponse({ run_attempt: 2 }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("run conclusion is failure");
  });

  it("rejects disagreement between the URL and the reported attempt before fetching", async () => {
    let fetched = false;
    const result = await verifyGithubActionsRun(env(), {
      target,
      runUrl: "https://github.com/acme/etl-jobs/actions/runs/1234567890/attempts/1",
      runId: 1234567890,
      runAttempt: 2,
      issuedAt,
      fetchImpl: async () => {
        fetched = true;
        return runResponse({ run_attempt: 2 });
      },
    });
    expect(result.ok).toBe(false);
    expect(fetched).toBe(false);
  });

  it("reports unverifiable without a GitHub token", async () => {
    const result = await verifyGithubActionsRun({} as Env, {
      target,
      runUrl: "https://github.com/acme/etl-jobs/actions/runs/1234567890",
      runId: 1234567890,
      issuedAt,
    });
    expect(result.ok).toBe(false);
    expect(result.result).toBe("unverifiable");
  });
});

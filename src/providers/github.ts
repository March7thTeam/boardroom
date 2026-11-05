import type { Env } from "../types";

export interface GithubActionsTarget {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
}

export interface GithubActionsRun {
  id: number;
  run_attempt: number;
  html_url: string;
  head_sha: string | null;
  conclusion: string | null;
  event: string;
  path: string;
  created_at: string;
}

export type RunVerifyCode =
  | "ok"
  | "not_found"
  | "failed"
  | "sha_mismatch"
  | "unverifiable";

export interface RunVerifyResult {
  ok: boolean;
  result: RunVerifyCode;
  run?: GithubActionsRun;
  error?: string;
}

const RUN_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/?$/;

function workflowMatches(runPath: string, workflow: string): boolean {
  if (runPath === workflow) return true;
  const base = runPath.split("/").at(-1);
  return base === workflow || base === workflow.split("/").at(-1);
}

/**
 * Verify a GitHub Actions run against the project allow-list and the ticket.
 * Artifacts are only recorded as declared hashes in S2; the platform does not
 * download them (S3).
 */
export async function verifyGithubActionsRun(
  env: Env,
  input: {
    target: GithubActionsTarget;
    runUrl: string;
    runId: number | string;
    runAttempt?: number;
    issuedAt: string;
    fetchImpl?: typeof fetch;
  },
): Promise<RunVerifyResult> {
  const match = RUN_URL_RE.exec(input.runUrl);
  if (!match) {
    return {
      ok: false,
      result: "failed",
      error: "run_url must be a GitHub Actions run URL",
    };
  }
  const [, owner, repo, urlRunId, urlAttempt] = match;
  if (owner !== input.target.owner || repo !== input.target.repo) {
    return {
      ok: false,
      result: "failed",
      error: "run_url repository is not in the project allow-list",
    };
  }
  if (String(urlRunId) !== String(input.runId)) {
    return {
      ok: false,
      result: "failed",
      error: "run_url run id does not match run.run_id",
    };
  }
  if (urlAttempt && input.runAttempt && Number(urlAttempt) !== input.runAttempt) {
    return {
      ok: false,
      result: "failed",
      error: "run_url attempt does not match run.run_attempt",
    };
  }
  const requestedAttempt = input.runAttempt ?? (urlAttempt ? Number(urlAttempt) : undefined);
  if (!env.GITHUB_TOKEN) {
    return {
      ok: false,
      result: "unverifiable",
      error: "GITHUB_TOKEN is not configured",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    // The run endpoint returns the latest rerun. A reported historical attempt
    // must be verified against its own result, even if another rerun now exists.
    const attemptPath = requestedAttempt === undefined ? "" : `/attempts/${requestedAttempt}`;
    response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(String(input.runId))}${attemptPath}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "boardroom",
        },
      },
    );
  } catch (error) {
    return {
      ok: false,
      result: "unverifiable",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 404) {
    return { ok: false, result: "not_found", error: "run not found" };
  }
  if (!response.ok) {
    return {
      ok: false,
      result: "unverifiable",
      error: `GitHub API returned ${response.status}`,
    };
  }

  const data = (await response.json()) as {
    id?: number;
    run_attempt?: number;
    html_url?: string;
    head_sha?: string | null;
    conclusion?: string | null;
    event?: string;
    path?: string;
    created_at?: string;
  };
  if (String(data.id ?? "") !== String(input.runId)) {
    return { ok: false, result: "failed", error: "GitHub API returned a different run id" };
  }
  if (requestedAttempt !== undefined && data.run_attempt !== requestedAttempt) {
    return { ok: false, result: "failed", error: "run_attempt does not match" };
  }
  if (data.conclusion !== "success") {
    return { ok: false, result: "failed", error: `run conclusion is ${data.conclusion ?? "unknown"}` };
  }
  if (data.event !== "workflow_dispatch" && data.event !== "push") {
    return { ok: false, result: "failed", error: `run event ${data.event ?? "unknown"} is not allowed` };
  }
  if (!data.created_at || new Date(data.created_at).getTime() <= new Date(input.issuedAt).getTime()) {
    return { ok: false, result: "failed", error: "run was created before the ticket was issued" };
  }
  if (!data.path || !workflowMatches(data.path, input.target.workflow)) {
    return { ok: false, result: "failed", error: "run workflow is not in the project allow-list" };
  }
  if (!data.head_sha) {
    return { ok: false, result: "sha_mismatch", error: "run does not expose head_sha" };
  }

  return {
    ok: true,
    result: "ok",
    run: {
      id: data.id as number,
      run_attempt: data.run_attempt ?? 1,
      html_url: data.html_url ?? input.runUrl,
      head_sha: data.head_sha,
      conclusion: data.conclusion,
      event: data.event,
      path: data.path,
      created_at: data.created_at,
    },
  };
}

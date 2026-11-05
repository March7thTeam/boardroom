#!/usr/bin/env node
/**
 * Verify the audit hash chain through the running Worker.
 * Usage: node scripts/verify-audit.mjs <project_id> [base_url]
 */
const projectId = process.argv[2];
const base = process.argv[3] ?? process.env.BASE_URL ?? "http://127.0.0.1:8787";
const email = process.env.DEV_EMAIL ?? "admin@example.com";

if (!projectId) {
  console.error("usage: node scripts/verify-audit.mjs <project_id> [base_url]");
  process.exit(2);
}

const response = await fetch(
  `${base}/api/v1/projects/${encodeURIComponent(projectId)}/audit/verify`,
  { headers: { "X-Dev-Email": email } },
);
let body;
try { body = await response.json(); } catch {
  console.error("invalid audit verification response");
  process.exit(1);
}

if (!response.ok) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

if (typeof body.ok !== "boolean" || typeof body.complete !== "boolean" ||
    !Number.isSafeInteger(body.pending) || body.pending < 0 ||
    !Number.isSafeInteger(body.checked) || !Number.isSafeInteger(body.as_of_seq) ||
    !Array.isArray(body.errors)) {
  console.error("invalid audit verification response");
  process.exit(1);
}

console.log(`checked ${body.checked} entries; pending=${body.pending}; as_of_seq=${body.as_of_seq}`);
if (body.head) console.log(`head seq=${body.head.seq} hash=${body.head.hash}`);
if (body.errors?.length) {
  for (const error of body.errors) {
    console.error(`${error.code}@${error.seq}: ${error.message}`);
  }
}
const complete = body.ok && body.complete && body.pending === 0 &&
  body.checked === body.as_of_seq && (body.head?.seq ?? 0) === body.as_of_seq;
console.log(complete ? "result: OK (complete)" : body.ok ? "result: PENDING (not fully published)" : "result: FAILED");
process.exit(complete ? 0 : body.ok ? 2 : 1);

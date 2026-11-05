#!/usr/bin/env node
/**
 * Boardroom agent helper for the `self-develop` project.
 *
 * Credentials are read from (in order):
 *   1. --file <path>
 *   2. BOARDROOM_AGENT_FILE
 *   3. ~/.boardroom/self-develop-agent.json
 *
 * The credential file is intentionally outside the repository and must never
 * be committed. It contains `base_url` and `agent_token`.
 *
 * Usage:
 *   node scripts/boardroom-agent.mjs me
 *   node scripts/boardroom-agent.mjs cards --status open --limit 50
 *   node scripts/boardroom-agent.mjs card <card_id>
 *   node scripts/boardroom-agent.mjs propose <card_id> <body.json>
 *   node scripts/boardroom-agent.mjs ticket <card_id> [body.json]
 *   node scripts/boardroom-agent.mjs lease <card_id> [ttl_minutes]
 *   node scripts/boardroom-agent.mjs unlease <card_id>
 *   node scripts/boardroom-agent.mjs run <card_id> <body.json>
 *   node scripts/boardroom-agent.mjs close <card_id> <reason> --if-match <version>
 *   node scripts/boardroom-agent.mjs reopen <card_id> [reason] --if-match <version>
 *   node scripts/boardroom-agent.mjs raw <METHOD> <path> [body.json] [--if-match <version>]
 *
 * See .opencode/skills/boardroom-self-develop/SKILL.md for the full workflow.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_CREDENTIAL = join(homedir(), ".boardroom", "self-develop-agent.json");

function usage() {
  console.log(`Boardroom agent helper

Commands:
  me                                     Show the authenticated agent
  cards [--status S] [--limit N]         List cards visible to this agent
  card <card_id>                         Read negotiation state for a card
  propose <card_id> <body.json>          Submit a proposal (adds message_id/type/card_id)
  ticket <card_id> [body.json]           Request an execution ticket
  lease <card_id> [ttl_minutes]          Acquire or renew a lease
  unlease <card_id>                      Release a lease
  run <card_id> <body.json>              Report a CI run and evidence
  close <card_id> <reason> --if-match N  Close a card you created
  reopen <card_id> [reason] --if-match N Reopen a card you created
  raw <METHOD> <path> [body.json]        Call any /agent endpoint

Options:
  --file <path>       Credential file (default: ${DEFAULT_CREDENTIAL})
  --if-match <n>      Send If-Match for card writes
  --status <status>   Card status filter
  --limit <n>         Page size
  --project <id>      Explicit project_id (single-project tokens default to their own)
  --since <iso>       Incremental card cursor input
  --cursor <value>    Opaque card cursor
  --help              Show this message`);
}

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) options[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) options[key] = argv[++i];
      else options[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

async function loadCredential(options) {
  const file = options.file || process.env.BOARDROOM_AGENT_FILE || DEFAULT_CREDENTIAL;
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `credential file not found: ${file}\n` +
        "Create it from the agent registration response, or set BOARDROOM_AGENT_FILE.",
    );
  }
  const credential = JSON.parse(raw);
  if (!credential.base_url || !credential.agent_token) {
    throw new Error(`credential file ${file} must contain base_url and agent_token`);
  }
  return credential;
}

async function readBody(path) {
  if (!path) return undefined;
  return JSON.parse(await readFile(path, "utf8"));
}

function buildQuery(options) {
  const query = new URLSearchParams();
  for (const key of ["status", "limit", "project_id", "since", "cursor"]) {
    const value = key === "project_id" ? (options.project_id ?? options.project) : options[key];
    if (value !== undefined && value !== true) query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

async function call(credential, method, path, body, options = {}) {
  if (!path.startsWith("/")) throw new Error(`path must start with /: ${path}`);
  const headers = {
    Authorization: `Bearer ${credential.agent_token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (options["if-match"] !== undefined) headers["If-Match"] = String(options["if-match"]);
  const response = await fetch(`${credential.base_url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${method} ${path}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return { status: response.status, body: parsed };
}

function print(result) {
  console.log(JSON.stringify(result.body ?? {}, null, 2));
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const [command, ...args] = positional;
  if (!command || command === "help" || options.help) {
    usage();
    return;
  }

  const credential = await loadCredential(options);
  const project = credential.project_id;

  switch (command) {
    case "me": {
      print(await call(credential, "GET", "/agent/me"));
      return;
    }
    case "cards": {
      const query = buildQuery({ ...options, ...(project ? { project_id: project } : {}) });
      print(await call(credential, "GET", `/agent/cards${query}`));
      return;
    }
    case "card": {
      const [cardId] = args;
      if (!cardId) throw new Error("usage: card <card_id>");
      print(await call(credential, "GET", `/agent/cards/${encodeURIComponent(cardId)}/negotiation`));
      return;
    }
    case "propose": {
      const [cardId, bodyPath] = args;
      if (!cardId || !bodyPath) throw new Error("usage: propose <card_id> <body.json>");
      const body = await readBody(bodyPath);
      body.card_id ??= cardId;
      body.type ??= "proposal";
      body.message_id ??= `msg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
      print(await call(credential, "POST", `/agent/cards/${encodeURIComponent(cardId)}/negotiate`, body));
      return;
    }
    case "ticket": {
      const [cardId, bodyPath] = args;
      if (!cardId) throw new Error("usage: ticket <card_id> [body.json]");
      print(await call(credential, "POST", `/agent/cards/${encodeURIComponent(cardId)}/tickets`, (await readBody(bodyPath)) ?? {}));
      return;
    }
    case "lease": {
      const [cardId, minutes] = args;
      if (!cardId) throw new Error("usage: lease <card_id> [ttl_minutes]");
      print(await call(credential, "POST", `/agent/cards/${encodeURIComponent(cardId)}/lease`, {
        ...(minutes === undefined ? {} : { ttl_minutes: Number(minutes) }),
      }));
      return;
    }
    case "unlease": {
      const [cardId] = args;
      if (!cardId) throw new Error("usage: unlease <card_id>");
      print(await call(credential, "DELETE", `/agent/cards/${encodeURIComponent(cardId)}/lease`));
      return;
    }
    case "run": {
      const [cardId, bodyPath] = args;
      if (!cardId || !bodyPath) throw new Error("usage: run <card_id> <body.json>");
      print(await call(credential, "POST", `/agent/cards/${encodeURIComponent(cardId)}/runs`, await readBody(bodyPath)));
      return;
    }
    case "close": {
      const [cardId, ...reasonParts] = args;
      const reason = reasonParts.join(" ");
      if (!cardId || !reason) throw new Error("usage: close <card_id> <reason> --if-match <version>");
      print(await call(credential, "POST", `/agent/cards/${encodeURIComponent(cardId)}/close`, { reason }, options));
      return;
    }
    case "reopen": {
      const [cardId, ...reasonParts] = args;
      if (!cardId) throw new Error("usage: reopen <card_id> [reason] --if-match <version>");
      const reason = reasonParts.join(" ");
      print(await call(credential, "POST", `/agent/cards/${encodeURIComponent(cardId)}/reopen`, reason ? { reason } : {}, options));
      return;
    }
    case "raw": {
      const [method, path, bodyPath] = args;
      if (!method || !path) throw new Error("usage: raw <METHOD> <path> [body.json]");
      print(await call(credential, method.toUpperCase(), path, await readBody(bodyPath), options));
      return;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (error && typeof error === "object" && "body" in error) console.error(JSON.stringify(error.body, null, 2));
  process.exitCode = 1;
});

import { base64UrlToBytes, bytesToBase64Url } from "./crypto";

export interface ParsedAgentToken {
  agentId: string;
  secret: string;
}

export interface ScopedAgentRef {
  projectId: string;
  localSlug: string;
}

// ULID alphabet excludes I, L, O and U.
const SCOPED_AGENT_REF = /^(prj_[0-9A-HJKMNP-TV-Z]{26}):([a-z0-9][a-z0-9-]*)$/;

/** Public agent identity in the current project: `<project_id>:<local_slug>`. */
export function formatScopedAgentRef(projectId: string, localSlug: string): string {
  return `${projectId}:${localSlug}`;
}

export function parseScopedAgentRef(value: string): ScopedAgentRef | null {
  const match = SCOPED_AGENT_REF.exec(value);
  if (!match) return null;
  return { projectId: match[1], localSlug: match[2] };
}

export function formatAgentToken(agentId: string, secret: string): string {
  const encodedId = bytesToBase64Url(new TextEncoder().encode(agentId));
  return `kbt1.${encodedId}.${secret}`;
}

export function parseAgentToken(raw: string): ParsedAgentToken | null {
  if (!raw.startsWith("kbt1.")) return null;
  const rest = raw.slice("kbt1.".length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  try {
    const agentId = new TextDecoder().decode(base64UrlToBytes(rest.slice(0, dot)));
    if (!SCOPED_AGENT_REF.test(agentId)) return null;
    return { agentId, secret: rest.slice(dot + 1) };
  } catch {
    return null;
  }
}

export interface ParsedEnrollmentToken {
  projectId: string;
  secret: string;
}

export function formatEnrollmentToken(projectId: string, secret: string): string {
  return `kbe1.${projectId}.${secret}`;
}

export function parseEnrollmentToken(raw: string): ParsedEnrollmentToken | null {
  if (!raw.startsWith("kbe1.")) return null;
  const rest = raw.slice("kbe1.".length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { projectId: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

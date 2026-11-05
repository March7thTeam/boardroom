import type { AgentStatus, CardOutcome, CardStatus, ConnectionStatus } from "../types";
import { DEFAULT_LOCALE, getTranslator, type TranslateFn } from "../i18n/core";

export interface BoardColumnMeta {
  key: CardStatus;
  label: string;
  codeLabel: string;
  icon: string;
  description: string;
}

const BOARD_COLUMN_BASE: ReadonlyArray<Omit<BoardColumnMeta, "label" | "description">> = [
  { key: "open", codeLabel: "OPEN", icon: "○" },
  { key: "engaged", codeLabel: "ENGAGED", icon: "◎" },
  { key: "running", codeLabel: "RUNNING", icon: "▶" },
  { key: "review", codeLabel: "REVIEW", icon: "◈" },
  { key: "closed", codeLabel: "CLOSED", icon: "■" },
];

function translator(t?: TranslateFn): TranslateFn {
  return t ?? getTranslator(DEFAULT_LOCALE);
}

export function getBoardColumnsMeta(t?: TranslateFn): BoardColumnMeta[] {
  const tr = translator(t);
  return BOARD_COLUMN_BASE.map((base) => ({
    ...base,
    label: tr(`board.${base.key}.label` as Parameters<TranslateFn>[0]),
    description: tr(`board.${base.key}.description` as Parameters<TranslateFn>[0]),
  }));
}

export function getStatusMeta(
  status: CardStatus,
  t?: TranslateFn,
): {
  label: string;
  icon: string;
  codeLabel: string;
} {
  const tr = translator(t);
  const found = BOARD_COLUMN_BASE.find((c) => c.key === status);
  return {
    label: tr(`board.${status}.label` as Parameters<TranslateFn>[0]),
    icon: found?.icon ?? "•",
    codeLabel: found?.codeLabel ?? String(status).toUpperCase(),
  };
}

export function getOutcomeMeta(
  outcome: CardOutcome,
  t?: TranslateFn,
): {
  label: string;
  icon: string;
  tone: string;
} | null {
  if (!outcome) return null;
  const tr = translator(t);
  const label = tr(`outcome.${outcome}` as Parameters<TranslateFn>[0]);
  switch (outcome) {
    case "done":
      return { label, icon: "✓", tone: "done" };
    case "rejected":
      return { label, icon: "✕", tone: "rejected" };
    case "cancelled":
      return { label, icon: "⊘", tone: "cancelled" };
    case "expired":
      return { label, icon: "⏱", tone: "expired" };
  }
}

export function getConnectionMeta(
  status: ConnectionStatus,
  t?: TranslateFn,
): {
  label: string;
  icon: string;
} {
  const tr = translator(t);
  switch (status) {
    case "connected":
      return { label: tr("connection.connected"), icon: "●" };
    case "reconnecting":
      return { label: tr("connection.reconnecting"), icon: "◌" };
    case "offline":
      return { label: tr("connection.offline"), icon: "✕" };
  }
}

export function getAgentStatusMeta(
  status: AgentStatus,
  t?: TranslateFn,
): {
  label: string;
  icon: string;
} {
  const tr = translator(t);
  switch (status) {
    case "active":
      return { label: tr("agentStatus.active"), icon: "●" };
    case "pending":
      return { label: tr("agentStatus.pending"), icon: "◐" };
    case "disabled":
      return { label: tr("agentStatus.disabled"), icon: "⊘" };
  }
}

export function formatShortId(
  id: string | null | undefined,
  agentMap?: ReadonlyMap<string, string>,
  t?: TranslateFn,
): string {
  if (!id) return translator(t)("card.unassigned");
  const mapped = agentMap?.get(id);
  if (mapped) return mapped;
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatRelativeOrShortTime(
  iso: string | null | undefined,
  t?: TranslateFn,
): string {
  if (!iso) return "—";
  const tr = translator(t);
  const d = new Date(iso);
  const ts = d.getTime();
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec >= 0 && diffSec < 60) return tr("time.secondsAgo", { count: diffSec });
  if (diffSec >= 60 && diffSec < 3600) {
    return tr("time.minutesAgo", { count: Math.floor(diffSec / 60) });
  }
  if (diffSec >= 3600 && diffSec < 86400) {
    return tr("time.hoursAgo", { count: Math.floor(diffSec / 3600) });
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function summarizePayload(payloadJson: string): string {
  if (!payloadJson) return "";
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return payloadJson;
    const entries = Object.entries(parsed);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        const valStr =
          typeof v === "string"
            ? v.length > 48
              ? `${v.slice(0, 48)}…`
              : v
            : JSON.stringify(v);
        return `${k}: ${valStr}`;
      })
      .join(" · ");
  } catch {
    return payloadJson;
  }
}

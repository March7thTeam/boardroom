import React, { useMemo } from "react";
import { CheckCircle2, Clock } from "lucide-react";
import { safeParseCriteriaJson } from "../api";
import type { Card } from "../types";
import { useI18n } from "../i18n";
import type { TranslateFn } from "../i18n/core";
import { OutcomeIcon, PriorityIcon, StatusIcon } from "./Icons";
import {
  formatDateTime,
  formatRelativeOrShortTime,
  formatShortId,
  getOutcomeMeta,
  getStatusMeta,
} from "./statusMeta";

type CardTileProps = {
  card: Card;
  isSelected: boolean;
  agentNameMap: ReadonlyMap<string, string>;
  onSelect: (cardId: string) => void;
};

function getPriorityTone(
  priority: number,
  t: TranslateFn,
): {
  label: string;
  symbol: string;
  className: string;
} {
  if (priority >= 80) {
    return {
      label: t("card.priorityUrgent", { priority }),
      symbol: "▲",
      className: "prio-high",
    };
  }
  if (priority >= 50) {
    return {
      label: t("card.priorityStandard", { priority }),
      symbol: "◆",
      className: "prio-med",
    };
  }
  return {
    label: t("card.priorityNormal", { priority }),
    symbol: "▽",
    className: "prio-low",
  };
}

const AVATAR_HUES = [262, 221, 172, 142, 32, 340, 199, 291];

/** Initial-based avatar; the hue is derived from the name so it stays stable. */
function Avatar({ name }: { name: string | null }): React.ReactElement {
  if (!name) return <span className="avatar avatar-empty" aria-hidden="true" />;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  const initial = name.replace(/^[^\p{L}\p{N}]+/u, "").charAt(0).toUpperCase() || "?";
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ ["--avatar-bg" as string]: `hsl(${hue} 55% 52%)` }}
    >
      {initial}
    </span>
  );
}

export function CardTile({
  card,
  isSelected,
  agentNameMap,
  onSelect,
}: CardTileProps): React.ReactElement {
  const { t } = useI18n();
  const prio = getPriorityTone(card.priority, t);
  const statusMeta = getStatusMeta(card.status, t);
  const outcomeMeta = getOutcomeMeta(card.outcome, t);

  const rulesCount = useMemo(
    () => safeParseCriteriaJson(card.criteria_json).length,
    [card.criteria_json],
  );

  const bodyPreview = useMemo(() => {
    const trimmed = card.body?.trim();
    if (!trimmed) return null;
    return trimmed.replace(/\s+/g, " ");
  }, [card.body]);

  const assigneeLabel =
    card.assignee_name ??
    (card.assignee_id
      ? formatShortId(card.assignee_id, agentNameMap, t)
      : t("card.unassigned"));
  const requesterLabel =
    card.requester_name ??
    (card.requester_id
      ? formatShortId(card.requester_id, agentNameMap, t)
      : t("card.unknownActor"));
  const requesterTypeLabel =
    card.requester_type === "agent"
      ? t("card.actorAgent")
      : card.requester_type === "user"
        ? t("card.actorUser")
        : t("card.actorSystem");
  const assigneeTypeLabel =
    card.assignee_type === "agent"
      ? t("card.actorAgent")
      : card.assignee_type === "user"
        ? t("card.actorUser")
        : null;

  return (
    <button
      type="button"
      className={`card-tile card-tile-status-${card.status} ${isSelected ? "card-tile-selected" : ""}`}
      onClick={() => onSelect(card.id)}
      aria-pressed={isSelected}
      aria-label={t("card.tileAria", {
        title: card.title,
        status: statusMeta.label,
        priority: card.priority,
      })}
    >
      <div className="card-tile-top">
        <span
          className={`badge badge-status-${card.status}`}
          title={`${statusMeta.label} (${statusMeta.codeLabel})`}
        >
          <StatusIcon status={card.status} size={11} /> {statusMeta.label}
        </span>

        <span
          className={`badge ${prio.className}`}
          title={t("card.priorityTitle", { priority: card.priority })}
        >
          <PriorityIcon priority={card.priority} size={11} /> {prio.label}
        </span>

        {outcomeMeta && (
          <span
            className={`badge badge-outcome-${outcomeMeta.tone}`}
            title={outcomeMeta.label}
          >
            <OutcomeIcon outcome={card.outcome} size={11} /> {outcomeMeta.label}
          </span>
        )}

        <span
          className="badge badge-neutral card-tile-round"
          title={t("card.roundTitle", { round: card.round })}
        >
          R{card.round} · v{card.version}
        </span>
      </div>

      <div className="card-tile-title">{card.title}</div>

      {bodyPreview && <p className="card-tile-body">{bodyPreview}</p>}

      <div className="card-tile-people">
        <span
          className="card-tile-person"
          title={t("card.assigneeTitle", {
            id: assigneeTypeLabel ? `${assigneeLabel} (${assigneeTypeLabel})` : assigneeLabel,
          })}
        >
          <Avatar name={card.assignee_id ? assigneeLabel : null} />
          <span className="card-tile-person-name">{assigneeLabel}</span>
        </span>
        <span
          className="card-tile-requester"
          title={t("card.requesterTitle", { id: `${requesterLabel} (${requesterTypeLabel})` })}
        >
          {t("card.requesterShort")} {requesterLabel}
        </span>
      </div>

      <div className="card-tile-footer">
        <span className="card-tile-footer-left">
          <span className="card-id-code" title={card.id}>
            #{card.id.slice(-6)}
          </span>
          {rulesCount > 0 && (
            <span className="card-extra-pill" title={t("card.rulesTitle", { count: rulesCount })}>
              <CheckCircle2 size={12} aria-hidden="true" />
              {rulesCount}
            </span>
          )}
          {card.deadline_at && (
            <span
              className="card-extra-pill"
              title={t("card.deadlineTitle", { time: formatDateTime(card.deadline_at) })}
            >
              <Clock size={12} aria-hidden="true" />
              {formatDateTime(card.deadline_at).slice(5, 16)}
            </span>
          )}
        </span>
        <time
          className="card-time"
          dateTime={card.updated_at}
          title={t("card.updatedAtTitle", { time: card.updated_at })}
        >
          {formatRelativeOrShortTime(card.updated_at, t)}
        </time>
      </div>
    </button>
  );
}

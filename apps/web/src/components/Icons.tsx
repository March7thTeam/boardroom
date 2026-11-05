import React from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Ban,
  Bot,
  CheckCircle2,
  Circle,
  CircleDot,
  Clock,
  Eye,
  Minus,
  Play,
  SquareCheck,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import type {
  AgentStatus,
  CardOutcome,
  CardStatus,
  ConnectionStatus,
} from "../types";

export function StatusIcon({
  status,
  size = 13,
  className,
}: {
  status: CardStatus;
  size?: number;
  className?: string;
}): React.ReactElement {
  switch (status) {
    case "open":
      return <Circle size={size} className={className} aria-hidden="true" />;
    case "engaged":
      return <CircleDot size={size} className={className} aria-hidden="true" />;
    case "running":
      return <Play size={size} className={className} aria-hidden="true" />;
    case "review":
      return <Eye size={size} className={className} aria-hidden="true" />;
    case "closed":
      return <SquareCheck size={size} className={className} aria-hidden="true" />;
  }
}

export function OutcomeIcon({
  outcome,
  size = 12,
}: {
  outcome: CardOutcome;
  size?: number;
}): React.ReactElement | null {
  if (!outcome) return null;
  switch (outcome) {
    case "done":
      return <CheckCircle2 size={size} aria-hidden="true" />;
    case "rejected":
      return <XCircle size={size} aria-hidden="true" />;
    case "cancelled":
      return <Ban size={size} aria-hidden="true" />;
    case "expired":
      return <Clock size={size} aria-hidden="true" />;
  }
}

export function PriorityIcon({
  priority,
  size = 12,
}: {
  priority: number;
  size?: number;
}): React.ReactElement {
  if (priority >= 80) {
    return <ArrowUp size={size} aria-hidden="true" />;
  }
  if (priority >= 50) {
    return <Minus size={size} aria-hidden="true" />;
  }
  return <ArrowDown size={size} aria-hidden="true" />;
}

export function ConnectionIcon({
  status,
  size = 12,
}: {
  status: ConnectionStatus;
  size?: number;
}): React.ReactElement {
  switch (status) {
    case "connected":
      return <Wifi size={size} aria-hidden="true" />;
    case "reconnecting":
      return <AlertCircle size={size} aria-hidden="true" />;
    case "offline":
      return <WifiOff size={size} aria-hidden="true" />;
  }
}

export function AgentStatusIcon({
  status,
  size = 12,
}: {
  status: AgentStatus;
  size?: number;
}): React.ReactElement {
  switch (status) {
    case "active":
      return <CheckCircle2 size={size} aria-hidden="true" />;
    case "pending":
      return <Clock size={size} aria-hidden="true" />;
    case "disabled":
      return <Ban size={size} aria-hidden="true" />;
  }
}

export { Bot };

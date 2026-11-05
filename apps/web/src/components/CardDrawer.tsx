import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Pencil, RefreshCw, RotateCcw, X } from "lucide-react";
import { api, ApiError, safeParseCriteriaJson } from "../api";
import { useI18n } from "../i18n";
import type { Card, ProjectRole, UserProfile } from "../types";
import { OutcomeIcon, StatusIcon } from "./Icons";
import {
  formatDateTime,
  formatShortId,
  getOutcomeMeta,
  getStatusMeta,
  summarizePayload,
} from "./statusMeta";

type CardDrawerProps = {
  cardId: string;
  projectId: string;
  projectRole?: ProjectRole;
  verificationMode?: "human" | "rule";
  fallbackCard?: Card | null;
  agentNameMap: ReadonlyMap<string, string>;
  currentUser: UserProfile;
  onClose: () => void;
  docked?: boolean;
  embedded?: boolean;
};

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function CardDrawer({
  cardId,
  projectId,
  projectRole,
  verificationMode,
  fallbackCard,
  agentNameMap,
  currentUser,
  onClose,
  docked = false,
  embedded = false,
}: CardDrawerProps): React.ReactElement {
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [showReopenModal, setShowReopenModal] = useState(false);
  const [reopenReason, setReopenReason] = useState("");

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editPriority, setEditPriority] = useState(50);
  const [editBaseVersion, setEditBaseVersion] = useState<number | null>(null);

  const [actionBanner, setActionBanner] = useState<{
    type: "error" | "warning" | "success";
    message: string;
  } | null>(null);

  const detailQuery = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => api.getCardDetail(cardId),
  });

  const negotiationQuery = useQuery({
    queryKey: ["card-negotiation", cardId],
    queryFn: () => api.getCardNegotiation(cardId),
  });

  const [interventionReason, setInterventionReason] = useState("");
  const [redirectPriority, setRedirectPriority] = useState(50);
  const [verdictReason, setVerdictReason] = useState("");
  const [shortCircuitReason, setShortCircuitReason] = useState("");
  const [shortCircuitTarget, setShortCircuitTarget] = useState("");

  const card = detailQuery.data?.card ?? fallbackCard ?? null;
  const events = useMemo(() => {
    const raw = detailQuery.data?.events ?? [];
    return [...raw].sort((a, b) => a.seq - b.seq);
  }, [detailQuery.data?.events]);

  const rules = useMemo(
    () => safeParseCriteriaJson(card?.criteria_json ?? null),
    [card?.criteria_json],
  );

  const canShortCircuit = currentUser.role === "admin" || projectRole === "owner";
  const shortCircuitReady = shortCircuitReason.trim().length >= 8;
  const shortCircuitAgentsQuery = useQuery({
    queryKey: ["project-agents", projectId],
    queryFn: () => api.getProjectAgents(projectId),
    enabled: canShortCircuit && card?.status === "open",
  });
  const shortCircuitAgents = useMemo(
    () => (shortCircuitAgentsQuery.data?.agents ?? []).filter((agent) => agent.status === "active"),
    [shortCircuitAgentsQuery.data],
  );

  const assigneeLabel =
    card?.assignee_name ??
    (card?.assignee_id
      ? formatShortId(card.assignee_id, agentNameMap, t)
      : t("card.unassigned"));
  const requesterLabel =
    card?.requester_name ??
    (card?.requester_id
      ? formatShortId(card.requester_id, agentNameMap, t)
      : t("card.unknownActor"));
  const assigneeTypeLabel =
    card?.assignee_type === "agent"
      ? t("card.actorAgent")
      : card?.assignee_type === "user"
        ? t("card.actorUser")
        : null;
  const requesterTypeLabel =
    card?.requester_type === "agent"
      ? t("card.actorAgent")
      : card?.requester_type === "user"
        ? t("card.actorUser")
        : t("card.actorSystem");
  const showCreator =
    Boolean(card?.creator_name) &&
    (card?.creator_id !== card?.requester_id || card?.creator_type !== card?.requester_type);

  const negotiation = negotiationQuery.data;
  const latestProposal = negotiation?.proposals.at(-1) ?? null;
  // `verify pass` in review requires at least one evidence row server-side.
  // Human attestation of an engaged contract creates that row itself.
  const evidenceCount = negotiation?.evidence?.length ?? 0;
  const humanAttestation = card?.status === "engaged" && verificationMode === "human";
  const passBlockedByEvidence = card?.status === "review" && evidenceCount === 0;
  const attestationReady = verdictReason.trim().length >= 8;
  const canAcceptProposal =
    card?.status === "open" &&
    card?.created_by_type === "user" &&
    card?.created_by_id === currentUser.id &&
    negotiation?.session?.initiator_user_id === currentUser.id &&
    Boolean(latestProposal);
  const interventionReady = interventionReason.trim().length >= 8;
  const isPaused = Boolean(card?.paused_at);

  // Reset sub-states when switching card
  useEffect(() => {
    setShowCancelModal(false);
    setCancelReason("");
    setCancelError(null);
    setShowReopenModal(false);
    setReopenReason("");
    setIsEditing(false);
    setEditBaseVersion(null);
    setActionBanner(null);
  }, [cardId]);

  // Keyboard Escape handler
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showCancelModal) {
          setShowCancelModal(false);
          return;
        }
        if (showReopenModal) {
          setShowReopenModal(false);
          return;
        }
        if (isEditing) {
          setIsEditing(false);
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showCancelModal, showReopenModal, isEditing, onClose]);

  const refreshCardAndBoard = () => {
    void queryClient.invalidateQueries({ queryKey: ["card", cardId] });
    void queryClient.invalidateQueries({ queryKey: ["card-negotiation", cardId] });
    void queryClient.invalidateQueries({ queryKey: ["board", projectId] });
  };

  const handleWriteError = (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 409) {
        setActionBanner({
          type: "warning",
          message: `版本冲突 (HTTP 409)：卡片已被其他操作更新，已为您自动刷新最新数据，请核对后重试。(${err.message})`,
        });
        refreshCardAndBoard();
        return;
      }
      if (err.status === 428) {
        setActionBanner({
          type: "error",
          message: `缺少版本前提条件 (HTTP 428 Precondition Required)：请求必须携带最新 If-Match 版本号，已自动同步最新状态。(${err.message})`,
        });
        refreshCardAndBoard();
        return;
      }
      setActionBanner({
        type: "error",
        message: `操作失败 [${err.code}]：${err.message}`,
      });
      return;
    }
    setActionBanner({
      type: "error",
      message: err instanceof Error ? err.message : "未知错误",
    });
  };

  const closeCardMutation = useMutation({
    mutationFn: ({ version, reason }: { version: number; reason: string }) =>
      api.closeCard(cardId, version, reason),
    onSuccess: (result) => {
      setShowCancelModal(false);
      setCancelReason("");
      setCancelError(null);
      setActionBanner({
        type: result.event_pending ? "warning" : "success",
        message: result.event_pending ? t("common.eventPending") : "卡片已取消并归档至「已关闭」列。",
      });
      refreshCardAndBoard();
    },
    onError: handleWriteError,
  });

  const reopenCardMutation = useMutation({
    mutationFn: ({ version, reason }: { version: number; reason?: string }) =>
      api.reopenCard(cardId, version, reason),
    onSuccess: (result) => {
      setShowReopenModal(false);
      setReopenReason("");
      setActionBanner({
        type: result.event_pending ? "warning" : "success",
        message: result.event_pending ? t("common.eventPending") : "卡片已重新打开。",
      });
      refreshCardAndBoard();
    },
    onError: handleWriteError,
  });

  const patchCardMutation = useMutation({
    mutationFn: ({
      version,
      title,
      body,
      priority,
    }: {
      version: number;
      title: string;
      body: string | null;
      priority: number;
    }) => api.patchCard(cardId, version, { title, body, priority }),
    onSuccess: (result) => {
      setIsEditing(false);
      setActionBanner({
        type: result.event_pending ? "warning" : "success",
        message: result.event_pending ? t("common.eventPending") : "卡片信息已更新。",
      });
      refreshCardAndBoard();
    },
    onError: handleWriteError,
  });

  const commitProposalMutation = useMutation({
    mutationFn: (input: {
      session_id: string;
      proposal_id: string;
      terms_hash: string;
    }) =>
      api.commitCard(cardId, {
        message_id: crypto.randomUUID(),
        ...input,
      }),
    onSuccess: (result) => {
      setActionBanner({ type: result.event_pending ? "warning" : "success", message: result.event_pending ? t("common.eventPending") : "已接受最新提案。" });
      refreshCardAndBoard();
    },
    onError: handleWriteError,
  });

  const verifyMutation = useMutation({
    mutationFn: (verdict: "pass" | "reject" | "needs_more") =>
      api.verifyCard(cardId, {
        message_id: crypto.randomUUID(),
        verdict,
        reasons: verdictReason.trim()
          ? [{ message: verdictReason.trim(), pass: verdict === "pass" }]
          : undefined,
      }),
    onSuccess: (result) => {
      setVerdictReason("");
      setActionBanner({ type: result.event_pending ? "warning" : "success", message: result.event_pending ? t("common.eventPending") : "验收结论已提交。" });
      refreshCardAndBoard();
    },
    onError: handleWriteError,
  });

  const interveneMutation = useMutation({
    mutationFn: (input: {
      type: "reject" | "redirect" | "takeover" | "pause" | "resume";
      payload?: { priority?: number };
    }) =>
      api.interveneCard(cardId, {
        message_id: crypto.randomUUID(),
        type: input.type,
        reason: interventionReason.trim(),
        payload: input.payload,
      }),
    onSuccess: (result) => {
      setInterventionReason("");
      setActionBanner({ type: result.event_pending ? "warning" : "success", message: result.event_pending ? t("common.eventPending") : "人工干预已记录。" });
      refreshCardAndBoard();
    },
    onError: handleWriteError,
  });

  const shortCircuitMutation = useMutation({
    mutationFn: (input: {
      action: "engage" | "verify" | "cancel" | "release" | "reset";
      verdict?: "pass" | "reject";
    }) => {
      const reason = shortCircuitReason.trim();
      if (reason.length < 8) throw new Error(t("shortCircuit.needReason"));
      if (input.action === "engage") {
        return api.shortCircuitCard(cardId, {
          action: "engage",
          message_id: crypto.randomUUID(),
          reason,
          ...(shortCircuitTarget ? { assignee_agent_id: shortCircuitTarget } : {}),
        });
      }
      if (input.action === "verify") {
        return api.shortCircuitCard(cardId, {
          action: "verify",
          message_id: crypto.randomUUID(),
          reason,
          verdict: input.verdict ?? "pass",
          reasons: verdictReason.trim()
            ? [{ message: verdictReason.trim(), pass: input.verdict === "pass" }]
            : undefined,
        });
      }
      return api.shortCircuitCard(cardId, {
        action: input.action,
        message_id: crypto.randomUUID(),
        reason,
      });
    },
    onSuccess: (result) => {
      setShortCircuitReason("");
      setActionBanner({
        type: result.event_pending ? "warning" : "success",
        message: result.event_pending ? t("common.eventPending") : t("shortCircuit.success"),
      });
      refreshCardAndBoard();
    },
    onError: handleWriteError,
  });

  const startEditing = () => {
    if (!card) return;
    setEditTitle(card.title);
    setEditBody(card.body ?? "");
    setEditPriority(card.priority);
    setEditBaseVersion(card.version);
    setIsEditing(true);
    setActionBanner(null);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!card || editBaseVersion === null) return;
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      setActionBanner({ type: "error", message: "标题不能为空" });
      return;
    }
    patchCardMutation.mutate({
      version: editBaseVersion,
      title: trimmedTitle,
      body: editBody.trim() ? editBody.trim() : null,
      priority: editPriority,
    });
  };

  const handleConfirmCancel = (e: React.FormEvent) => {
    e.preventDefault();
    if (!card) return;
    const trimmed = cancelReason.trim();
    if (trimmed.length < 8) {
      setCancelError(`取消理由至少需要 8 个字符（当前 ${trimmed.length} 字）`);
      return;
    }
    setCancelError(null);
    closeCardMutation.mutate({
      version: card.version,
      reason: trimmed,
    });
  };

  const handleConfirmReopen = (e: React.FormEvent) => {
    e.preventDefault();
    if (!card) return;
    reopenCardMutation.mutate({
      version: card.version,
      reason: reopenReason.trim() || undefined,
    });
  };

  const statusMeta = card ? getStatusMeta(card.status, t) : null;
  const outcomeMeta = card ? getOutcomeMeta(card.outcome, t) : null;
  const canCancel =
    card &&
    (card.status === "open" ||
      card.status === "engaged" ||
      card.status === "running" ||
      card.status === "review");
  const canReopen = card && card.status === "closed";

  const panelNode = (
    <aside
      className={
        embedded
          ? "editor-card-fullview"
          : docked
            ? "dock-content-panel"
            : "drawer-panel"
      }
      role={docked || embedded ? "region" : "dialog"}
      aria-modal={docked || embedded ? undefined : "true"}
      aria-label="卡片详情抽屉"
      onClick={(e) => e.stopPropagation()}
    >
      <header className="drawer-header">
          <div className="drawer-header-meta">
            <span className="drawer-id-code">ID: {cardId}</span>
            {card && statusMeta && (
              <span className={`badge badge-status-${card.status}`}>
                <StatusIcon status={card.status} size={11} /> {statusMeta.label} (
                {statusMeta.codeLabel})
              </span>
            )}
            {outcomeMeta && card && (
              <span className={`badge badge-outcome-${outcomeMeta.tone}`}>
                <OutcomeIcon outcome={card.outcome} size={11} /> {outcomeMeta.label}
              </span>
            )}
            {card && (
              <span className="badge badge-neutral" title="卡片乐观锁版本号">
                版本 v{card.version} · Round {card.round}
              </span>
            )}
          </div>
          <div className="drawer-header-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={refreshCardAndBoard}
              title="手动刷新卡片详情"
            >
              <RefreshCw size={12} aria-hidden="true" /> 刷新
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              aria-label="关闭抽屉"
            >
              <X size={13} aria-hidden="true" /> 关闭
            </button>
          </div>
        </header>

        <div className="drawer-body">
          {actionBanner && (
            <div
              className={`alert alert-${actionBanner.type}`}
              role="alert"
            >
              <span>{actionBanner.message}</span>
              <button
                type="button"
                className="btn-inline-close"
                onClick={() => setActionBanner(null)}
                aria-label="关闭提示"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          )}

          {detailQuery.isError && (
            <div className="alert alert-error" role="alert">
              <strong>加载卡片详情失败：</strong>{" "}
              {detailQuery.error instanceof ApiError
                ? `${detailQuery.error.message} (${detailQuery.error.code})`
                : detailQuery.error instanceof Error
                  ? detailQuery.error.message
                  : "请求异常"}
            </div>
          )}

          {!card && detailQuery.isLoading && (
            <div className="loading-state">正在加载卡片详情与事件时间线…</div>
          )}

          {card && (
            <>
              <section className="drawer-section">
                {!isEditing ? (
                  <>
                    <div className="drawer-title-row">
                      <h2 className="drawer-title">{card.title}</h2>
                      <div className="drawer-action-bar">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={startEditing}
                        >
                          <Pencil size={12} aria-hidden="true" /> 编辑
                        </button>
                        {canCancel && (
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => {
                              setCancelError(null);
                              setShowCancelModal(true);
                            }}
                          >
                            <Ban size={12} aria-hidden="true" /> 取消卡片
                          </button>
                        )}
                        {canReopen && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => setShowReopenModal(true)}
                          >
                            <RotateCcw size={12} aria-hidden="true" /> 重新打开
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="meta-grid">
                      <div className="meta-item">
                        <span className="meta-label">优先级</span>
                        <span className="meta-value">P{card.priority}</span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">{t("card.assigneeLabel")}</span>
                        <span className="meta-value">
                          <code>{assigneeLabel}</code>
                          {assigneeTypeLabel && (
                            <span className="field-hint"> · {assigneeTypeLabel}</span>
                          )}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">{t("card.requesterLabel")}</span>
                        <span className="meta-value">
                          <code>{requesterLabel}</code>
                          <span className="field-hint"> · {requesterTypeLabel}</span>
                        </span>
                      </div>
                      {showCreator && (
                        <div className="meta-item">
                          <span className="meta-label">{t("card.creatorLabel")}</span>
                          <span className="meta-value">
                            <code>{card.creator_name}</code>
                          </span>
                        </div>
                      )}
                      <div className="meta-item">
                        <span className="meta-label">截止时间</span>
                        <span className="meta-value">
                          {formatDateTime(card.deadline_at)}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">创建时间</span>
                        <span className="meta-value">
                          {formatDateTime(card.created_at)}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">更新时间</span>
                        <span className="meta-value">
                          {formatDateTime(card.updated_at)}
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <form className="drawer-inline-form" onSubmit={handleEditSubmit}>
                    <div className="section-subtitle">
                      {t("card.editVersion", { version: editBaseVersion ?? card.version })}
                    </div>
                    {editBaseVersion !== card.version && <div className="alert alert-warning" role="status">{t("card.editRemoteChanged")}</div>}
                    <div className="form-field">
                      <label htmlFor="edit-card-title">标题</label>
                      <input
                        id="edit-card-title"
                        type="text"
                        className="input"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="edit-card-priority">优先级 (0-100)</label>
                      <input
                        id="edit-card-priority"
                        type="number"
                        className="input input-mono"
                        min={0}
                        max={100}
                        value={editPriority}
                        onChange={(e) => setEditPriority(Number(e.target.value))}
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="edit-card-body">任务详情 (Body)</label>
                      <textarea
                        id="edit-card-body"
                        className="textarea"
                        rows={4}
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                      />
                    </div>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setIsEditing(false)}
                        disabled={patchCardMutation.isPending}
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        className="btn btn-primary btn-sm"
                        disabled={patchCardMutation.isPending}
                      >
                        {patchCardMutation.isPending ? "保存中…" : "保存修改"}
                      </button>
                    </div>
                  </form>
                )}

                {showCancelModal && (
                  <form
                    className="drawer-action-dialog alert-warning"
                    onSubmit={handleConfirmCancel}
                    aria-label="取消卡片确认表单"
                  >
                    <div className="dialog-title">
                      <Ban size={13} aria-hidden="true" />{" "}
                      <strong>确认取消卡片</strong> (If-Match: v{card.version})
                    </div>
                    <p className="helper-text">
                      取消后卡片将进入「已关闭 (cancelled)」状态。请填写不少于 8
                      个字的取消原因：
                    </p>
                    {cancelError && (
                      <div className="text-danger" role="alert">
                        {cancelError}
                      </div>
                    )}
                    <textarea
                      className="textarea"
                      rows={3}
                      placeholder="请输入取消原因（至少 8 个字符）…"
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      autoFocus
                      required
                    />
                    <div className="form-actions">
                      <span className="char-counter">
                        已输入 {cancelReason.trim().length} / 8 字
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setShowCancelModal(false)}
                        disabled={closeCardMutation.isPending}
                      >
                        返回
                      </button>
                      <button
                        type="submit"
                        className="btn btn-danger btn-sm"
                        disabled={closeCardMutation.isPending}
                      >
                        {closeCardMutation.isPending ? "处理中…" : "确认取消卡片"}
                      </button>
                    </div>
                  </form>
                )}

                {showReopenModal && (
                  <form
                    className="drawer-action-dialog"
                    onSubmit={handleConfirmReopen}
                    aria-label="重新打开卡片确认表单"
                  >
                    <div className="dialog-title">
                      <RotateCcw size={13} aria-hidden="true" />{" "}
                      <strong>重新打开卡片</strong> (If-Match: v{card.version})
                    </div>
                    <p className="helper-text">
                      重新打开后卡片将回到待协商状态，可附带重开说明（选填）：
                    </p>
                    <input
                      type="text"
                      className="input"
                      placeholder="选填：重新打开的原因说明…"
                      value={reopenReason}
                      onChange={(e) => setReopenReason(e.target.value)}
                      autoFocus
                    />
                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setShowReopenModal(false)}
                        disabled={reopenCardMutation.isPending}
                      >
                        返回
                      </button>
                      <button
                        type="submit"
                        className="btn btn-primary btn-sm"
                        disabled={reopenCardMutation.isPending}
                      >
                        {reopenCardMutation.isPending ? "处理中…" : "确认重新打开"}
                      </button>
                    </div>
                  </form>
                )}
              </section>

              <section className="drawer-section">
                <h3 className="section-title">任务详情 (Body)</h3>
                {card.body ? (
                  <pre className="card-body-box">{card.body}</pre>
                ) : (
                  <div className="empty-inline">暂无正文描述</div>
                )}
              </section>

              <section className="drawer-section">
                <h3 className="section-title">
                  验收规则 ({rules.length})
                </h3>
                {rules.length > 0 ? (
                  <table className="rules-table">
                    <thead>
                      <tr>
                        <th>字段 (Key)</th>
                        <th>操作符 (Op)</th>
                        <th>期望值 (Value)</th>
                        <th>级别</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((r, idx) => (
                        <tr key={`${r.key}-${idx}`}>
                          <td>
                            <code>{r.key}</code>
                          </td>
                          <td>
                            <span className="badge badge-neutral">{r.op}</span>
                          </td>
                          <td>
                            <code>
                              {r.value === undefined
                                ? "—"
                                : typeof r.value === "string"
                                  ? r.value
                                  : JSON.stringify(r.value)}
                            </code>
                          </td>
                          <td>
                            <span className="badge badge-neutral">
                              {r.severity ?? "block"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="empty-inline">未配置结构化验收规则</div>
                )}
              </section>

              <section className="drawer-section">
                <h3 className="section-title">协商与执行</h3>
                {negotiationQuery.isLoading ? (
                  <div className="loading-state">正在加载协商记录…</div>
                ) : negotiationQuery.isError ? (
                  <div className="alert alert-error" role="alert">
                    {negotiationQuery.error instanceof Error
                      ? negotiationQuery.error.message
                      : "协商记录加载失败"}
                  </div>
                ) : (
                  <>
                    {negotiation?.session && (
                      <div className="meta-grid">
                        <div className="meta-item">
                          <span className="meta-label">会话</span>
                          <span className="meta-value">
                            <code>{negotiation.session.id}</code>
                          </span>
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">轮次 / 状态</span>
                          <span className="meta-value">
                            R{negotiation.session.round} ·{" "}
                            <code>{negotiation.session.state}</code>
                          </span>
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">发起方</span>
                          <span className="meta-value">
                            <code>
                              {negotiation.session.initiator_agent_id
                                ? formatShortId(
                                    negotiation.session.initiator_agent_id,
                                    agentNameMap,
                                  )
                                : requesterLabel}
                            </code>
                          </span>
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">响应方</span>
                          <span className="meta-value">
                            <code>
                              {formatShortId(
                                negotiation.session.responder_agent_id,
                                agentNameMap,
                              )}
                            </code>
                          </span>
                        </div>
                      </div>
                    )}

                    {(negotiation?.proposals ?? []).length > 0 ? (
                      <div className="proposal-list">
                        {(negotiation?.proposals ?? []).map((proposal) => (
                          <div key={proposal.id} className="proposal-item">
                            <div className="proposal-head">
                              <strong>提案 #{proposal.seq_in_session}</strong>
                              <span className="badge badge-neutral">
                                {proposal.status}
                              </span>
                              <code>
                                {formatShortId(proposal.from_agent_id, agentNameMap)}
                              </code>
                            </div>
                            <pre className="card-body-box">
                              {prettyJson(proposal.terms_json)}
                            </pre>
                            <div className="field-hint">
                              <code>{proposal.terms_hash}</code>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-inline">暂无提案</div>
                    )}

                    {latestProposal && canAcceptProposal && negotiation?.session && (
                      <div className="form-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={commitProposalMutation.isPending}
                          onClick={() =>
                            commitProposalMutation.mutate({
                              session_id: negotiation.session!.id,
                              proposal_id: latestProposal.id,
                              terms_hash: latestProposal.terms_hash,
                            })
                          }
                        >
                          {commitProposalMutation.isPending
                            ? "处理中…"
                            : "接受最新提案"}
                        </button>
                      </div>
                    )}

                    {negotiation?.contract && (
                      <div className="proposal-item">
                        <div className="proposal-head">
                          <strong>合同</strong>
                          <span className="badge badge-neutral">
                            {negotiation.contract.state}
                          </span>
                        </div>
                        <div className="field-hint">
                          <code>{negotiation.contract.terms_hash}</code>
                        </div>
                        <pre className="card-body-box">
                          {prettyJson(negotiation.contract.terms_json)}
                        </pre>
                      </div>
                    )}

                    {(negotiation?.attempts ?? []).length > 0 && (
                      <div>
                        <div className="meta-label">执行记录</div>
                        <ul className="timeline-list">
                          {(negotiation?.attempts ?? []).map((attempt) => (
                            <li key={attempt.id} className="timeline-item">
                              <div className="timeline-item-header">
                                <span className="timeline-seq">
                                  #{attempt.attempt_no}
                                </span>
                                <span className="timeline-type">
                                  {attempt.status}
                                </span>
                                <span className="timeline-actor">
                                  {attempt.verify_result ?? "—"}
                                </span>
                              </div>
                              {attempt.run_url && (
                                <div className="field-hint">
                                  <a
                                    href={attempt.run_url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {attempt.run_url}
                                  </a>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {(negotiation?.evidence ?? []).length > 0 && (
                      <div>
                        <div className="meta-label">
                          证据（自报，未下载复算）
                        </div>
                        <ul className="timeline-list">
                          {(negotiation?.evidence ?? []).map((item) => (
                            <li key={item.id} className="timeline-item">
                              <div className="timeline-item-header">
                                <span className="timeline-type">{item.kind}</span>
                                <span className="timeline-actor">
                                  {item.summary ?? "—"}
                                </span>
                              </div>
                              <div className="field-hint">
                                <code>{item.sha256}</code> · {item.size_bytes} B
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {(card.status === "review" || humanAttestation) && (
                      <div className="drawer-action-dialog">
                        <div className="dialog-title">
                          {humanAttestation ? t("card.humanAttestTitle") : "验收"}
                        </div>
                        {humanAttestation && (
                          <div className="field-hint">{t("card.humanAttestHint")}</div>
                        )}
                        <textarea
                          className="textarea"
                          rows={2}
                          placeholder={
                            humanAttestation
                              ? t("card.humanAttestPlaceholder")
                              : "验收意见（选填）…"
                          }
                          value={verdictReason}
                          onChange={(e) => setVerdictReason(e.target.value)}
                        />
                        {humanAttestation && !attestationReady && (
                          <div className="field-hint">{t("card.humanAttestRequired")}</div>
                        )}
                        {passBlockedByEvidence && (
                          <div className="field-hint">{t("card.evidenceRequired")}</div>
                        )}
                        <div className="form-actions">
                          {!humanAttestation && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={verifyMutation.isPending}
                              onClick={() => verifyMutation.mutate("needs_more")}
                            >
                              要求补充
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={
                              verifyMutation.isPending ||
                              (humanAttestation && !attestationReady)
                            }
                            onClick={() => verifyMutation.mutate("reject")}
                          >
                            拒绝
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={
                              verifyMutation.isPending ||
                              passBlockedByEvidence ||
                              (humanAttestation && !attestationReady)
                            }
                            title={passBlockedByEvidence ? t("card.evidenceRequired") : undefined}
                            onClick={() => verifyMutation.mutate("pass")}
                          >
                            通过
                          </button>
                        </div>
                      </div>
                    )}

                    {card.status !== "closed" && (
                      <div className="drawer-action-dialog">
                        <div className="dialog-title">人工干预</div>
                        <textarea
                          className="textarea"
                          rows={2}
                          placeholder="干预原因（至少 8 个字符）…"
                          value={interventionReason}
                          onChange={(e) => setInterventionReason(e.target.value)}
                        />
                        <div className="form-actions">
                          <input
                            type="number"
                            className="input input-mono"
                            style={{ width: 90 }}
                            min={0}
                            max={100}
                            value={redirectPriority}
                            onChange={(e) =>
                              setRedirectPriority(Number(e.target.value))
                            }
                            title="重定向后的优先级"
                          />
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={interveneMutation.isPending || !interventionReady}
                            onClick={() =>
                              interveneMutation.mutate({
                                type: isPaused ? "resume" : "pause",
                              })
                            }
                          >
                            {isPaused ? "恢复" : "暂停"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={interveneMutation.isPending || !interventionReady}
                            onClick={() =>
                              interveneMutation.mutate({
                                type: "redirect",
                                payload: { priority: redirectPriority },
                              })
                            }
                          >
                            重定向
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={interveneMutation.isPending || !interventionReady}
                            onClick={() => interveneMutation.mutate({ type: "takeover" })}
                          >
                            接管
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={interveneMutation.isPending || !interventionReady}
                            onClick={() => interveneMutation.mutate({ type: "reject" })}
                          >
                            驳回
                          </button>
                        </div>
                      </div>
                    )}

                    {canShortCircuit && card.status !== "closed" && (
                      <div className="drawer-action-dialog">
                        <div className="dialog-title">
                          {t("shortCircuit.title")}
                          <span className="badge badge-neutral">
                            {currentUser.role === "admin"
                              ? t("shortCircuit.levelInstance")
                              : t("shortCircuit.levelProject")}
                          </span>
                        </div>
                        <div className="field-hint">{t("shortCircuit.hint")}</div>
                        <textarea
                          className="textarea"
                          rows={2}
                          placeholder={t("shortCircuit.reasonPlaceholder")}
                          value={shortCircuitReason}
                          onChange={(e) => setShortCircuitReason(e.target.value)}
                        />
                        {card.status === "open" && (
                          <select
                            className="select"
                            value={shortCircuitTarget}
                            onChange={(e) => setShortCircuitTarget(e.target.value)}
                          >
                            <option value="">{t("shortCircuit.engageLabel")}</option>
                            {shortCircuitAgents.map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.resolved_name || agent.slug}
                              </option>
                            ))}
                          </select>
                        )}
                        {card.status === "open" && shortCircuitAgents.length === 0 && (
                          <div className="field-hint">{t("shortCircuit.noAgents")}</div>
                        )}
                        {card.status === "review" && passBlockedByEvidence && (
                          <div className="field-hint">{t("shortCircuit.bypassEvidence")}</div>
                        )}
                        {card.status === "running" && (
                          <div className="field-hint">{t("shortCircuit.releaseHint")}</div>
                        )}
                        {(card.status === "engaged" ||
                          card.status === "running" ||
                          card.status === "review") && (
                          <div className="field-hint">{t("shortCircuit.resetHint")}</div>
                        )}
                        <div className="field-hint">{t("shortCircuit.cancelHint")}</div>
                        <div className="form-actions">
                          {card.status === "open" && (
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={
                                shortCircuitMutation.isPending ||
                                !shortCircuitReady ||
                                !shortCircuitTarget
                              }
                              onClick={() => shortCircuitMutation.mutate({ action: "engage" })}
                            >
                              {t("shortCircuit.engage")}
                            </button>
                          )}
                          {card.status === "review" && (
                            <>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                disabled={shortCircuitMutation.isPending || !shortCircuitReady}
                                onClick={() =>
                                  shortCircuitMutation.mutate({ action: "verify", verdict: "reject" })
                                }
                              >
                                {t("shortCircuit.verifyReject")}
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                disabled={shortCircuitMutation.isPending || !shortCircuitReady}
                                onClick={() =>
                                  shortCircuitMutation.mutate({ action: "verify", verdict: "pass" })
                                }
                              >
                                {t("shortCircuit.verifyPass")}
                              </button>
                            </>
                          )}
                          {card.status === "running" && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={shortCircuitMutation.isPending || !shortCircuitReady}
                              onClick={() => shortCircuitMutation.mutate({ action: "release" })}
                            >
                              {t("shortCircuit.release")}
                            </button>
                          )}
                          {(card.status === "engaged" ||
                            card.status === "running" ||
                            card.status === "review") && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={shortCircuitMutation.isPending || !shortCircuitReady}
                              onClick={() => shortCircuitMutation.mutate({ action: "reset" })}
                            >
                              {t("shortCircuit.reset")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={shortCircuitMutation.isPending || !shortCircuitReady}
                            onClick={() => shortCircuitMutation.mutate({ action: "cancel" })}
                          >
                            {t("shortCircuit.cancel")}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>

              <section className="drawer-section">
                <h3 className="section-title">
                  事件时间线 ({events.length} 条 · 按 seq 升序)
                </h3>
                {detailQuery.isLoading ? (
                  <div className="loading-state">正在加载事件记录…</div>
                ) : events.length === 0 ? (
                  <div className="empty-inline">暂无事件记录</div>
                ) : (
                  <ol className="timeline-list">
                    {events.map((ev) => (
                      <li key={ev.event_id} className="timeline-item">
                        <div className="timeline-item-header">
                          <span className="timeline-seq">#{ev.seq}</span>
                          <span className="timeline-type">{ev.event_type}</span>
                          <span className="timeline-actor">
                            [{ev.actor_type}]{" "}
                            <code>{formatShortId(ev.actor_id, agentNameMap)}</code>
                          </span>
                          <time
                            className="timeline-time"
                            dateTime={ev.created_at}
                          >
                            {formatDateTime(ev.created_at)}
                          </time>
                        </div>
                        <div className="timeline-payload">
                          <code>{summarizePayload(ev.payload_json)}</code>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
  );

  if (docked || embedded) {
    return panelNode;
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      {panelNode}
    </div>
  );
}

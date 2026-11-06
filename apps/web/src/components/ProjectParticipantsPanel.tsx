import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Bot,
  Check,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  UserRound,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { api, ApiError } from "../api";
import type { AgentSummary, ProjectMember } from "../types";
import { useI18n } from "../i18n";
import { AgentStatusIcon } from "./Icons";
import { InstanceRoleBadge, ProjectRoleBadge } from "./RoleBadges";
import { formatDateTime, getAgentStatusMeta } from "./statusMeta";

type ProjectParticipantsPanelProps = {
  projectId: string;
  currentUserId: string;
  canManage: boolean;
  members: ProjectMember[];
  membersLoading: boolean;
  membersError: Error | null;
  agents: AgentSummary[];
  agentsLoading: boolean;
  agentsError: Error | null;
  onRefreshMembers: () => void;
  onRefreshAgents: () => void;
  onClose: () => void;
};

type Banner = { type: "success" | "error"; text: string };

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export function ProjectParticipantsPanel({
  projectId,
  currentUserId,
  canManage,
  members,
  membersLoading,
  membersError,
  agents,
  agentsLoading,
  agentsError,
  onRefreshMembers,
  onRefreshAgents,
  onClose,
}: ProjectParticipantsPanelProps): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmTransferId, setConfirmTransferId] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const refreshMembers = () => {
    void queryClient.invalidateQueries({ queryKey: ["projectMembers", projectId] });
  };

  const refreshAgents = () => {
    void queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
  };

  const addMemberMutation = useMutation({
    mutationFn: () =>
      api.addProjectMember(projectId, { email: email.trim(), role }),
    onSuccess: () => {
      setEmail("");
      setRole("member");
      setBanner({ type: "success", text: t("participants.added") });
      refreshMembers();
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text: describeError(error, t("participants.addFailed")),
      });
    },
  });

  // A project has exactly one owner (issue #14); ownership moves by transfer.
  const transferOwnerMutation = useMutation({
    mutationFn: (userId: string) => api.transferProjectOwner(projectId, userId),
    onSuccess: () => {
      setConfirmTransferId(null);
      setBanner({ type: "success", text: t("participants.ownerTransferred") });
      refreshMembers();
      // The caller's own project role changed; refresh project lists.
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text: describeError(error, t("participants.transferFailed")),
      });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.removeProjectMember(projectId, userId),
    onSuccess: () => {
      setConfirmRemoveId(null);
      setBanner({ type: "success", text: t("participants.removed") });
      refreshMembers();
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text: describeError(error, t("participants.removeFailed")),
      });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({
      userId,
      nextRole,
    }: {
      userId: string;
      nextRole: "admin" | "member";
    }) => api.updateProjectMemberRole(projectId, userId, nextRole),
    onSuccess: () => {
      setBanner({ type: "success", text: t("participants.roleUpdated") });
      refreshMembers();
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text: describeError(error, t("participants.updateFailed")),
      });
    },
  });

  const agentStatusMutation = useMutation({
    mutationFn: ({
      agentId,
      status,
    }: {
      agentId: string;
      status: "active" | "disabled";
    }) => api.setAgentStatus(projectId, agentId, status),
    onSuccess: () => {
      refreshAgents();
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text: describeError(error, t("participants.agentStatusFailed")),
      });
    },
  });

  const joinRequestsQuery = useQuery({
    queryKey: ["projectJoinRequests", projectId],
    queryFn: () => api.getProjectJoinRequests(projectId),
    enabled: canManage,
  });

  const decideJoinMutation = useMutation({
    mutationFn: ({
      userId,
      status,
    }: {
      userId: string;
      status: "approved" | "rejected";
    }) => api.decideProjectJoinRequest(projectId, userId, status),
    onSuccess: (_data, variables) => {
      setBanner({
        type: "success",
        text:
          variables.status === "approved"
            ? t("participants.joinApproved")
            : t("participants.joinRejected"),
      });
      void queryClient.invalidateQueries({
        queryKey: ["projectJoinRequests", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["projectMembers", projectId],
      });
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text: describeError(error, t("participants.joinDecisionFailed")),
      });
    },
  });

  const submitAddMember = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setBanner({ type: "error", text: t("participants.emailRequired") });
      return;
    }
    addMemberMutation.mutate();
  };

  const joinRequests = joinRequestsQuery.data?.join_requests ?? [];
  const joinRequestsError =
    joinRequestsQuery.error instanceof Error ? joinRequestsQuery.error : null;
  const loadingError = membersError ?? agentsError ?? joinRequestsError;

  return (
    <div className="dock-content-panel">
      <div className="drawer-header">
        <h2 className="dock-panel-heading">
          <Users size={14} aria-hidden="true" />
          <span>
            {t("participants.title")} ({members.length + agents.length})
          </span>
        </h2>
        <div className="drawer-header-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              onRefreshMembers();
              onRefreshAgents();
              void joinRequestsQuery.refetch();
            }}
            aria-label={t("common.retry")}
            title={t("common.retry")}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label={t("app.dockCollapse")}
            title={t("app.dockCollapse")}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="drawer-body">
        {banner && (
          <div className={`alert alert-${banner.type}`} role="alert">
            <span>{banner.text}</span>
            <button
              type="button"
              className="btn-inline-close"
              onClick={() => setBanner(null)}
              aria-label={t("common.close")}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        )}

        {loadingError && (
          <div className="alert alert-error" role="alert">
            <span>{describeError(loadingError, t("participants.loadFailed"))}</span>
          </div>
        )}

        {!canManage && (
          <div className="field-hint participants-hint">{t("participants.onlyOwner")}</div>
        )}

        {canManage && (
          <form className="drawer-inline-form" onSubmit={submitAddMember}>
            <div className="section-subtitle">
              <UserRound size={13} aria-hidden="true" />
              <span>{t("participants.addMember")}</span>
            </div>

            <div className="form-field">
              <label htmlFor="participant-email">{t("participants.email")}</label>
              <input
                id="participant-email"
                type="email"
                className="input"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="member@example.com"
                required
              />
              <span className="field-hint">{t("participants.emailHint")}</span>
            </div>

            <div className="form-field">
              <label htmlFor="participant-role">
                <Shield size={12} aria-hidden="true" /> {t("participants.role")}
              </label>
              <select
                id="participant-role"
                className="select"
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as "admin" | "member")
                }
              >
                <option value="member">{t("participants.roleMember")}</option>
                <option value="admin">{t("participants.roleAdmin")}</option>
              </select>
              <span className="field-hint">{t("participants.roleHint")}</span>
            </div>

            <span className="field-hint">{t("participants.ownerHint")}</span>

            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={addMemberMutation.isPending}
              >
                <Plus size={13} aria-hidden="true" />
                <span>
                  {addMemberMutation.isPending
                    ? t("common.loading")
                    : t("participants.addMember")}
                </span>
              </button>
            </div>
          </form>
        )}

        {canManage && (
          <section className="participants-section">
            <div className="participants-section-header">
              <h3 className="section-title">
                <UserRound size={13} aria-hidden="true" />
                <span>
                  {t("participants.joinRequests")} ({joinRequests.length})
                </span>
              </h3>
            </div>

            {joinRequestsQuery.isLoading ? (
              <div className="loading-state">{t("common.loading")}</div>
            ) : joinRequests.length === 0 ? (
              <div className="empty-inline">
                {t("participants.noJoinRequests")}
              </div>
            ) : (
              <div className="dock-list">
                {joinRequests.map((request) => (
                  <div key={request.user_id} className="dock-agent-item">
                    <div className="dock-agent-top">
                      <strong>{request.display_name || request.email}</strong>
                      <span className="badge badge-neutral">
                        {t("join.pending")}
                      </span>
                    </div>

                    <div className="field-hint">
                      <code>{request.email}</code> ·{" "}
                      <code>{request.user_id}</code>
                    </div>

                    <div className="field-hint">
                      {t("participants.requestedAt", {
                        time: formatDateTime(request.requested_at),
                      })}
                    </div>

                    {request.note && (
                      <div className="field-hint">
                        {t("participants.joinNote")}: {request.note}
                      </div>
                    )}

                    <div className="drawer-header-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={decideJoinMutation.isPending}
                        onClick={() =>
                          decideJoinMutation.mutate({
                            userId: request.user_id,
                            status: "approved",
                          })
                        }
                      >
                        <Check size={12} aria-hidden="true" />
                        <span>{t("participants.approve")}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={decideJoinMutation.isPending}
                        onClick={() =>
                          decideJoinMutation.mutate({
                            userId: request.user_id,
                            status: "rejected",
                          })
                        }
                      >
                        <XCircle size={12} aria-hidden="true" />
                        <span>{t("participants.reject")}</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="participants-section">
          <div className="participants-section-header">
            <h3 className="section-title">
              <Users size={13} aria-hidden="true" />
              <span>
                {t("participants.humans")} ({members.length})
              </span>
            </h3>
          </div>

          {membersLoading ? (
            <div className="loading-state">{t("common.loading")}</div>
          ) : members.length === 0 ? (
            <div className="empty-inline">{t("participants.noMembers")}</div>
          ) : (
            <div className="dock-list">
              {members.map((member) => {
                const isSelf = member.id === currentUserId;
                const isOwner = member.role === "owner";
                const confirming = confirmRemoveId === member.id;
                const confirmingTransfer = confirmTransferId === member.id;
                const memberName = member.display_name || member.email;
                return (
                  <div key={member.id} className="dock-agent-item">
                    <div className="dock-agent-top">
                      <strong>{memberName}</strong>
                      <ProjectRoleBadge role={member.role} />
                    </div>

                    <div className="field-hint">
                      <code>{member.email}</code>
                      {isSelf && (
                        <span className="badge badge-neutral participants-self-badge">
                          {t("participants.self")}
                        </span>
                      )}
                    </div>

                    <div className="field-hint participants-instance-role">
                      {t("participants.globalRole")}:{" "}
                      <InstanceRoleBadge role={member.global_role} />
                      {" · "}
                      {member.global_status === "active"
                        ? t("participants.accountActive")
                        : t("participants.accountDisabled")}
                    </div>

                    <div className="field-hint">
                      {t("participants.addedAt", {
                        time: formatDateTime(member.added_at),
                      })}
                    </div>

                    {canManage && !isSelf && !isOwner && (
                      <>
                        <div className="participants-role-control">
                          <label
                            className="field-hint"
                            htmlFor={`participant-role-${member.id}`}
                          >
                            <Shield size={12} aria-hidden="true" />{" "}
                            {t("participants.changeRole")}
                          </label>
                          <select
                            id={`participant-role-${member.id}`}
                            className="select select-sm"
                            value={member.role}
                            disabled={updateRoleMutation.isPending}
                            onChange={(event) =>
                              updateRoleMutation.mutate({
                                userId: member.id,
                                nextRole: event.target.value as
                                  | "admin"
                                  | "member",
                              })
                            }
                          >
                            <option value="member">
                              {t("participants.roleMember")}
                            </option>
                            <option value="admin">
                              {t("participants.roleAdmin")}
                            </option>
                          </select>
                        </div>

                        <div className="drawer-header-actions">
                        {confirmingTransfer ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={transferOwnerMutation.isPending}
                              onClick={() => transferOwnerMutation.mutate(member.id)}
                            >
                              <span className="btn-label">
                                {t("participants.confirmTransfer", { name: memberName })}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setConfirmTransferId(null)}
                            >
                              {t("participants.cancelRemove")}
                            </button>
                          </>
                        ) : confirming ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={removeMemberMutation.isPending}
                              onClick={() => removeMemberMutation.mutate(member.id)}
                            >
                              {t("participants.confirmRemove")}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setConfirmRemoveId(null)}
                            >
                              {t("participants.cancelRemove")}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => {
                                setConfirmRemoveId(null);
                                setConfirmTransferId(member.id);
                              }}
                            >
                              <ArrowRightLeft size={12} aria-hidden="true" />
                              <span>{t("participants.transferOwner")}</span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => {
                                setConfirmTransferId(null);
                                setConfirmRemoveId(member.id);
                              }}
                            >
                              <Trash2 size={12} aria-hidden="true" />
                              <span>{t("participants.remove")}</span>
                            </button>
                          </>
                        )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="participants-section">
          <div className="participants-section-header">
            <h3 className="section-title">
              <Bot size={13} aria-hidden="true" />
              <span>
                {t("participants.agents")} ({agents.length})
              </span>
            </h3>
            <span className="field-hint">{t("participants.agentHint")}</span>
          </div>

          {agentsLoading ? (
            <div className="loading-state">{t("common.loading")}</div>
          ) : agents.length === 0 ? (
            <div className="empty-inline">{t("participants.noAgents")}</div>
          ) : (
            <div className="dock-list">
              {agents.map((agent) => {
                const statusMeta = getAgentStatusMeta(agent.status, t);
                const nextStatus =
                  agent.status === "active" ? "disabled" : "active";
                return (
                  <div key={agent.id} className="dock-agent-item">
                    <div className="dock-agent-top">
                      <strong>{agent.resolved_name}</strong>
                      <span className={`badge badge-agent-${agent.status}`}>
                        <AgentStatusIcon status={agent.status} size={11} />
                        {statusMeta.label}
                      </span>
                    </div>

                    <div className="field-hint">
                      <code>{agent.slug}</code> · <code>{agent.harness}</code> ·{" "}
                      {t("participants.agentProjectCount", {
                        count: agent.project_count ?? 1,
                      })}
                    </div>

                    {canManage ? (
                      <div className="drawer-header-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={agentStatusMutation.isPending}
                          onClick={() =>
                            agentStatusMutation.mutate({
                              agentId: agent.id,
                              status: nextStatus,
                            })
                          }
                        >
                          {agent.status === "active"
                            ? t("participants.agentDisable")
                            : t("participants.agentEnable")}
                        </button>
                      </div>
                    ) : (
                      <div className="field-hint">
                        {t("participants.manageAgentsHint")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

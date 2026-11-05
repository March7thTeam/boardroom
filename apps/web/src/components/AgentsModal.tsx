import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, KeyRound, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { AgentSummary, Project } from "../types";
import { useI18n } from "../i18n";
import { AgentStatusIcon } from "./Icons";
import { getAgentStatusMeta } from "./statusMeta";
import { ProjectTokenNotice } from "./ProjectTokenNotice";

type AgentsModalProps = {
  projectId: string;
  project: Pick<Project, "name" | "slug">;
  agents: AgentSummary[];
  isLoading: boolean;
  error: Error | null;
  onClose: () => void;
  /** The parent owns acknowledgement so list refreshes cannot lose this token. */
  onTokenIssued?: (projectId: string, token: string) => void;
  docked?: boolean;
  windowed?: boolean;
};

export function AgentsModal({
  projectId,
  project,
  agents,
  isLoading,
  error,
  onClose,
  onTokenIssued,
  docked = false,
  windowed = false,
}: AgentsModalProps): React.ReactElement {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const toggleStatusMutation = useMutation({
    mutationFn: ({
      agentId,
      status,
    }: {
      agentId: string;
      status: "active" | "disabled";
    }) => api.setAgentStatus(projectId, agentId, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
    },
  });

  const tokenMutation = useMutation({
    mutationFn: () => api.createProjectToken(projectId),
    onSuccess: (data) => {
      if (onTokenIssued) {
        setIssuedToken(null);
        onTokenIssued(projectId, data.enrollment_token);
      } else {
        setIssuedToken(data.enrollment_token);
      }
    },
  });

  const mutationErrMsg =
    toggleStatusMutation.error instanceof ApiError
      ? `${toggleStatusMutation.error.message} (${toggleStatusMutation.error.code})`
      : toggleStatusMutation.error instanceof Error
        ? toggleStatusMutation.error.message
        : tokenMutation.error instanceof ApiError
          ? `${tokenMutation.error.message} (${tokenMutation.error.code})`
          : tokenMutation.error instanceof Error
            ? tokenMutation.error.message
            : null;

  const innerContent = (
    <div
      className={
        windowed
          ? "window-inner-panel"
          : docked
            ? "dock-content-panel"
            : "panel-card modal-card"
      }
    >
      {!windowed && (
        <div className={docked ? "drawer-header" : "panel-header"}>
          <h2 id="agents-modal-title" className="dock-panel-heading">
            <Bot size={14} aria-hidden="true" />
            <span>协作 Agents ({agents.length})</span>
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="关闭 Agent 列表窗口"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className={docked || windowed ? "drawer-body" : "panel-body"}>
        {(error || mutationErrMsg) && (
          <div className="alert alert-error" role="alert">
            <strong>错误：</strong> {mutationErrMsg || error?.message}
          </div>
        )}

        <div className="agents-token-row">
          <span className="field-hint">{t("project.tokenHelp")}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={tokenMutation.isPending}
            onClick={() => tokenMutation.mutate()}
          >
            <KeyRound size={13} aria-hidden="true" />
            <span>
              {tokenMutation.isPending
                ? t("project.generatingToken")
                : t("project.generateToken")}
            </span>
          </button>
        </div>

        {isLoading ? (
          <div className="loading-state">正在加载项目 Agent…</div>
        ) : agents.length === 0 ? (
          <div className="empty-inline">
            当前项目暂未注册任何 Agent。请使用项目创建时生成的 Enrollment Token
            接入 Agent。
          </div>
        ) : docked ? (
          <div className="dock-list">
            {agents.map((agent) => {
              const st = getAgentStatusMeta(agent.status, t);
              const nextStatus =
                agent.status === "active" ? "disabled" : "active";
              return (
                <div key={agent.id} className="dock-agent-item">
                  <div className="dock-agent-top">
                    <strong>{agent.resolved_name}</strong>
                    <span className={`badge badge-agent-${agent.status}`}>
                      <AgentStatusIcon status={agent.status} size={11} /> {st.label}
                    </span>
                  </div>
                  <div className="field-hint">
                    <code>{agent.slug}</code> · <code>{agent.harness}</code> · 并发{" "}
                    {agent.max_concurrency} ·{" "}
                    {t("participants.agentProjectCount", {
                      count: agent.project_count ?? 1,
                    })}
                  </div>
                  <div className="dock-agent-actions">
                    <span className="field-hint">
                      <code>{agent.id}</code>
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={toggleStatusMutation.isPending}
                      onClick={() =>
                        toggleStatusMutation.mutate({
                          agentId: agent.id,
                          status: nextStatus,
                        })
                      }
                    >
                      {agent.status === "active" ? "停用" : "启用"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <table className="rules-table">
              <thead>
                <tr>
                  <th>名称 / 标识</th>
                  <th>Harness</th>
                  <th>并发上限</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const st = getAgentStatusMeta(agent.status, t);
                  const nextStatus =
                    agent.status === "active" ? "disabled" : "active";
                  return (
                    <tr key={agent.id}>
                      <td>
                        <div>
                          <strong>{agent.resolved_name}</strong>
                        </div>
                        <div className="field-hint">
                          <code>{agent.slug}</code> · <code>{agent.id}</code>
                        </div>
                      </td>
                      <td>
                        <code>{agent.harness}</code>
                      </td>
                      <td>{agent.max_concurrency}</td>
                      <td>
                        <span className={`badge badge-agent-${agent.status}`}>
                          <AgentStatusIcon status={agent.status} size={11} /> {st.label}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={toggleStatusMutation.isPending}
                          onClick={() =>
                            toggleStatusMutation.mutate({
                              agentId: agent.id,
                              status: nextStatus,
                            })
                          }
                        >
                          {agent.status === "active" ? "停用" : "启用"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
  );

  const tokenNotice = issuedToken ? (
    <ProjectTokenNotice
      project={project}
      token={issuedToken}
      title={t("project.newTokenTitle", { name: project.name })}
      intro={t("project.newTokenIntro")}
      dismissLabel={t("common.close")}
      onDismiss={() => setIssuedToken(null)}
    />
  ) : null;

  if (docked || windowed) {
    return (
      <>
        {innerContent}
        {tokenNotice}
      </>
    );
  }

  return (
    <>
      <div
        className="modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agents-modal-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        {innerContent}
      </div>
      {tokenNotice}
    </>
  );
}

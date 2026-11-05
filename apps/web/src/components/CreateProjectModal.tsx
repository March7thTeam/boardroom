import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FolderPlus, LogIn, RefreshCw, X } from "lucide-react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";
import type { Project } from "../types";
import { formatDateTime } from "./statusMeta";

const SLUG_REGEX = /^[a-z][a-z0-9-]{1,30}$/;

type CreateProjectFormProps = {
  mode: "empty-screen" | "modal" | "dock" | "window";
  onCreated: (project: Project, enrollmentToken: string) => void;
  onCancel?: () => void;
  /** Only global admins can create projects; regular members can join instead. */
  canCreate?: boolean;
};

export function CreateProjectView({
  mode,
  onCreated,
  onCancel,
  canCreate = true,
}: CreateProjectFormProps): React.ReactElement {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [emptyScreenView, setEmptyScreenView] = useState<"create" | "join">(
    canCreate ? "create" : "join",
  );

  const createMutation = useMutation({
    mutationFn: (input: { slug: string; name: string }) => api.createProject(input),
    // Hand the token to the parent immediately; it owns the acknowledgement
    // dialog so a project-list refresh cannot unmount the token view.
    onSuccess: (data) => onCreated(data.project, data.enrollment_token),
  });

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) {
      const autoSlug = value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/^([0-9-])/, "p-$1")
        .slice(0, 31);
      setSlug(autoSlug);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();

    if (!trimmedName) {
      setValidationError("请输入项目名称");
      return;
    }

    if (!SLUG_REGEX.test(trimmedSlug)) {
      setValidationError(
        "项目标识 (slug) 必须以小写字母开头，仅含小写字母、数字或连字符，总长度 2-31 个字符（正则：^[a-z][a-z0-9-]{1,30}$）",
      );
      return;
    }

    createMutation.mutate({
      name: trimmedName,
      slug: trimmedSlug,
    });
  };

  const apiErrMsg =
    createMutation.error instanceof ApiError
      ? `${createMutation.error.message} (${createMutation.error.code})`
      : createMutation.error instanceof Error
        ? createMutation.error.message
        : null;

  const isEmbedded = mode === "dock" || mode === "window";

  const content = (
    <form className={isEmbedded ? "dock-inline-box" : "panel-card create-project-card"} onSubmit={handleSubmit}>
      {mode !== "window" && (
        <div className="panel-header">
          <h2 className="dock-panel-heading">
            <FolderPlus size={15} aria-hidden="true" />
            <span>{mode === "empty-screen" ? "创建首个项目" : "新建项目"}</span>
          </h2>
          {(mode === "modal" || mode === "dock") && onCancel && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onCancel}
              aria-label="关闭新建项目窗口"
            >
              <X size={13} aria-hidden="true" /> 关闭
            </button>
          )}
        </div>
      )}
      <div className="panel-body">
        {mode === "empty-screen" && (
          <p className="helper-text">
            当前账号下暂无项目。请先创建一个项目以启动 Agent 协商看板。
          </p>
        )}

        {(validationError || apiErrMsg) && (
          <div className="alert alert-error" role="alert">
            <strong>错误：</strong> {validationError || apiErrMsg}
          </div>
        )}

        <div className="form-field">
          <label htmlFor="project-name-input">
            项目名称 <span className="required-mark">*</span>
          </label>
          <input
            id="project-name-input"
            type="text"
            className="input"
            placeholder="例如：数据仓库日终治理"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="form-field">
          <label htmlFor="project-slug-input">
            项目标识 (slug) <span className="required-mark">*</span>
          </label>
          <input
            id="project-slug-input"
            type="text"
            className="input input-mono"
            placeholder="例如：dw-daily-gov"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            pattern="^[a-z][a-z0-9-]{1,30}$"
            required
          />
          <span className="field-hint">
            规则：小写字母开头，仅含 <code>a-z</code>、<code>0-9</code>、<code>-</code>，长度 2~31
          </span>
        </div>

        <div className="form-actions">
          {(mode === "modal" || mode === "dock" || mode === "window") && onCancel && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
              disabled={createMutation.isPending}
            >
              取消
            </button>
          )}
          {mode === "empty-screen" && canCreate && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginRight: "auto" }}
              onClick={() => setEmptyScreenView("join")}
            >
              <LogIn size={13} aria-hidden="true" />
              <span>{t("join.title")}</span>
            </button>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "创建中…" : "创建项目"}
          </button>
        </div>
      </div>
    </form>
  );

  if (mode === "dock" || mode === "window") {
    return content;
  }

  if (mode === "modal") {
    return (
      <div
        className="modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="新建项目"
        onKeyDown={(e) => {
          if (e.key === "Escape" && onCancel) onCancel();
        }}
      >
        {content}
      </div>
    );
  }

  if (emptyScreenView === "join") {
    return (
      <div className="empty-screen-container">
        <JoinProjectCard
          onBack={canCreate ? () => setEmptyScreenView("create") : undefined}
        />
      </div>
    );
  }

  return <div className="empty-screen-container">{content}</div>;
}

function JoinProjectCard({
  onBack,
}: {
  onBack?: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [note, setNote] = useState("");
  const [banner, setBanner] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const myRequestsQuery = useQuery({
    queryKey: ["myJoinRequests"],
    queryFn: () => api.getMyJoinRequests(),
  });

  const requestMutation = useMutation({
    mutationFn: () => api.requestProjectJoin(projectId.trim(), note),
    onSuccess: () => {
      setBanner({ type: "success", text: t("join.submitted") });
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["myJoinRequests"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text:
          error instanceof ApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : t("join.requestFailed"),
      });
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId.trim()) {
      setBanner({ type: "error", text: t("join.projectIdRequired") });
      return;
    }
    requestMutation.mutate();
  };

  const requests = myRequestsQuery.data?.join_requests ?? [];

  return (
    <div className="panel-card create-project-card">
      <div className="panel-header">
        <h2 className="dock-panel-heading">
          <LogIn size={15} aria-hidden="true" />
          <span>{t("join.title")}</span>
        </h2>
        {onBack && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            <ArrowLeft size={13} aria-hidden="true" />
            <span>{t("join.back")}</span>
          </button>
        )}
      </div>

      <div className="panel-body">
        <p className="helper-text">{t("join.intro")}</p>

        {banner && (
          <div className={`alert alert-${banner.type}`} role="alert">
            <span>{banner.text}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="join-project-id">
              {t("join.projectId")} <span className="required-mark">*</span>
            </label>
            <input
              id="join-project-id"
              type="text"
              className="input input-mono"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder="prj_..."
              required
              autoFocus
            />
            <span className="field-hint">{t("join.projectIdHint")}</span>
          </div>

          <div className="form-field">
            <label htmlFor="join-project-note">{t("join.note")}</label>
            <textarea
              id="join-project-note"
              className="input"
              rows={3}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("join.note")}
            />
          </div>

          <div className="form-actions">
            {onBack && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onBack}
                disabled={requestMutation.isPending}
              >
                <ArrowLeft size={13} aria-hidden="true" />
                <span>{t("join.back")}</span>
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={requestMutation.isPending}
            >
              <LogIn size={13} aria-hidden="true" />
              <span>
                {requestMutation.isPending
                  ? t("join.submitting")
                  : t("join.submit")}
              </span>
            </button>
          </div>
        </form>

        <div className="drawer-section">
          <div className="drawer-header">
            <h3 className="section-title">{t("join.myRequests")}</h3>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void myRequestsQuery.refetch()}
              disabled={myRequestsQuery.isFetching}
            >
              <RefreshCw size={12} aria-hidden="true" />
              <span>{t("join.refresh")}</span>
            </button>
          </div>

          {myRequestsQuery.isLoading ? (
            <div className="loading-state">{t("common.loading")}</div>
          ) : myRequestsQuery.isError ? (
            <div className="alert alert-error" role="alert">
              {myRequestsQuery.error instanceof Error
                ? myRequestsQuery.error.message
                : t("join.loadFailed")}
            </div>
          ) : requests.length === 0 ? (
            <div className="empty-inline">{t("join.noRequests")}</div>
          ) : (
            <div className="dock-list">
              {requests.map((request) => (
                <div key={request.project_id} className="dock-agent-item">
                  <div className="dock-agent-top">
                    <strong>{request.project_name}</strong>
                    <span
                      className={`badge ${
                        request.status === "pending"
                          ? "badge-neutral"
                          : "badge-agent-disabled"
                      }`}
                    >
                      {request.status === "pending"
                        ? t("join.pending")
                        : t("join.rejected")}
                    </span>
                  </div>
                  <div className="field-hint">
                    <code>{request.project_slug}</code> ·{" "}
                    <code>{request.project_id}</code>
                  </div>
                  <div className="field-hint">
                    {formatDateTime(request.requested_at)}
                  </div>
                  {request.note && (
                    <div className="field-hint">{request.note}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

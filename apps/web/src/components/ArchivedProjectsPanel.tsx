import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, RefreshCw, Trash2, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { ArchivedProject } from "../types";
import { useI18n } from "../i18n";
import { formatDateTime } from "./statusMeta";

type ArchivedProjectsPanelProps = {
  projects: ArchivedProject[];
  isLoading: boolean;
  error: Error | null;
  isAdmin: boolean;
  onRestored: (projectId: string) => void;
  onPurged: (projectId: string) => void;
};

function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return fallback;
}

export function ArchivedProjectsPanel({
  projects,
  isLoading,
  error,
  isAdmin,
  onRestored,
  onPurged,
}: ArchivedProjectsPanelProps): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [purgeTargetId, setPurgeTargetId] = useState<string | null>(null);
  const [purgeSlug, setPurgeSlug] = useState("");
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["archivedProjects"] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  };

  const restore = useMutation({
    mutationFn: (projectId: string) => api.restoreProject(projectId),
    onSuccess: (data) => {
      setBanner({ type: "success", text: t("projectArchive.restoreSuccess") });
      refresh();
      onRestored(data.project.id);
    },
    onError: (err) => {
      setBanner({
        type: "error",
        text: describeError(err, t("projectArchive.restoreFailed")),
      });
    },
  });

  const purge = useMutation({
    mutationFn: ({ projectId, slug }: { projectId: string; slug: string }) =>
      api.purgeProject(projectId, slug),
    onSuccess: (data, variables) => {
      setBanner({
        type: data.events_purged ? "success" : "error",
        text: data.events_purged
          ? t("projectArchive.purgeSuccess")
          : t("projectArchive.purgePartial"),
      });
      setPurgeTargetId(null);
      setPurgeSlug("");
      refresh();
      onPurged(variables.projectId);
    },
    onError: (err) => {
      setBanner({
        type: "error",
        text: describeError(err, t("projectArchive.purgeFailed")),
      });
    },
  });

  return (
    <section className="participants-section archived-projects-section">
      <div className="participants-section-header">
        <h3 className="section-title">
          <ArchiveRestore size={13} aria-hidden="true" />
          <span>
            {t("projectArchive.listTitle")} ({projects.length})
          </span>
        </h3>
      </div>

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

      {isLoading ? (
        <div className="loading-state">{t("common.loading")}</div>
      ) : error ? (
        <div className="alert alert-error" role="alert">
          <span>{describeError(error, t("projectArchive.loadFailed"))}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={refresh}
          >
            <RefreshCw size={12} aria-hidden="true" />
            <span>{t("common.retry")}</span>
          </button>
        </div>
      ) : projects.length === 0 ? (
        <div className="empty-inline">{t("projectArchive.empty")}</div>
      ) : (
        <div className="dock-list">
          {projects.map((project) => {
            const confirming = purgeTargetId === project.id;
            return (
              <div key={project.id} className="dock-agent-item">
                <div className="dock-agent-top">
                  <strong>{project.name}</strong>
                  <span className="badge badge-neutral">
                    {t("projectArchive.archivedBadge")}
                  </span>
                </div>

                <div className="field-hint">
                  <code>{project.slug}</code>
                  {project.original_slug && project.original_slug !== project.slug && (
                    <> · {t("projectArchive.originalSlug")}: <code>{project.original_slug}</code></>
                  )}
                </div>

                <div className="field-hint">
                  {t("projectArchive.archivedAt", {
                    time: formatDateTime(project.archived_at),
                  })}
                  {project.archived_by_email
                    ? ` · ${t("projectArchive.archivedBy", { email: project.archived_by_email })}`
                    : ""}
                </div>

                {project.archive_reason && (
                  <div className="field-hint">
                    {t("projectArchive.reasonLabel")}: {project.archive_reason}
                  </div>
                )}

                <div className="drawer-header-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(project.id)}
                  >
                    <ArchiveRestore size={12} aria-hidden="true" />
                    <span>{t("projectArchive.restore")}</span>
                  </button>

                  {isAdmin && !confirming && (
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => {
                        setPurgeTargetId(project.id);
                        setPurgeSlug("");
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      <span>{t("projectArchive.purge")}</span>
                    </button>
                  )}
                </div>

                {isAdmin && confirming && (
                  <div className="archive-confirm-box">
                    <div className="field-hint archive-warning">
                      {t("projectArchive.purgeWarning")}
                    </div>
                    <div className="form-field">
                      <label htmlFor={`purge-slug-${project.id}`}>
                        {t("projectArchive.purgeConfirmLabel", { slug: project.slug })}
                      </label>
                      <input
                        id={`purge-slug-${project.id}`}
                        className="input input-mono"
                        value={purgeSlug}
                        onChange={(event) => setPurgeSlug(event.target.value)}
                        placeholder={project.slug}
                        autoComplete="off"
                      />
                    </div>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={purge.isPending}
                        onClick={() => {
                          setPurgeTargetId(null);
                          setPurgeSlug("");
                        }}
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={
                          purge.isPending ||
                          (purgeSlug.trim() !== project.slug &&
                            purgeSlug.trim() !== project.original_slug)
                        }
                        onClick={() =>
                          purge.mutate({ projectId: project.id, slug: purgeSlug.trim() })
                        }
                      >
                        {purge.isPending
                          ? t("common.loading")
                          : t("projectArchive.purgeConfirm")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, FolderCog } from "lucide-react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";

type ProjectSettingsModalProps = {
  projectId: string;
  onClose: () => void;
  onArchived?: (projectId: string) => void;
  embedded?: boolean;
};

type ExecTargetJson = {
  provider?: string;
  owner?: string;
  repo?: string;
  workflows?: string[];
};

export function ProjectSettingsModal({
  projectId,
  onClose,
  onArchived,
  embedded = false,
}: ProjectSettingsModalProps): React.ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });

  const [verificationMode, setVerificationMode] = useState<"human" | "rule">("human");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [workflows, setWorkflows] = useState("");
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );

  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const [archiveSlug, setArchiveSlug] = useState("");
  const [archiveReason, setArchiveReason] = useState("");

  const project = query.data?.project;

  useEffect(() => {
    if (!project) return;
    setVerificationMode(project.verification_mode);
    let targets: ExecTargetJson[] = [];
    try {
      const parsed = JSON.parse(project.exec_targets_json);
      if (Array.isArray(parsed)) targets = parsed as ExecTargetJson[];
    } catch {
      targets = [];
    }
    const first = targets.find((item) => item.provider === "github_actions");
    setOwner(first?.owner ?? "");
    setRepo(first?.repo ?? "");
    setWorkflows((first?.workflows ?? []).join(", "));
  }, [project]);

  const save = useMutation({
    mutationFn: () => {
      const list = workflows
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return api.updateProject(projectId, {
        verification_mode: verificationMode,
        exec_targets:
          owner.trim() && repo.trim() && list.length > 0
            ? [
                {
                  provider: "github_actions" as const,
                  owner: owner.trim(),
                  repo: repo.trim(),
                  workflows: list,
                },
              ]
            : [],
      });
    },
    onSuccess: () => {
      setBanner({ type: "success", text: t("projectSettings.saved") });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text:
          error instanceof ApiError
            ? `${error.message} (${error.code})`
            : error instanceof Error
              ? error.message
              : t("projectSettings.loadFailed"),
      });
    },
  });

  const archive = useMutation({
    mutationFn: () => api.archiveProject(projectId, archiveSlug.trim(), archiveReason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["archivedProjects"] });
      setArchiveExpanded(false);
      setArchiveSlug("");
      setArchiveReason("");
      onArchived?.(projectId);
    },
    onError: (error) => {
      setBanner({
        type: "error",
        text:
          error instanceof ApiError
            ? `${error.message} (${error.code})`
            : error instanceof Error
              ? error.message
              : t("projectArchive.failed"),
      });
    },
  });

  return (
    <div
      className={
        embedded ? "editor-card-fullview project-settings-fullview" : "dock-inline-box"
      }
    >
      <div className="panel-header">
        <h2 className="dock-panel-heading">
          <FolderCog size={14} aria-hidden="true" />
          <span>{t("projectSettings.title")}</span>
        </h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          {t("common.close")}
        </button>
      </div>
      <div className="panel-body">
        {query.isLoading ? (
          <div className="loading-state">{t("common.loading")}</div>
        ) : query.isError ? (
          <div className="alert alert-error" role="alert">
            {query.error instanceof Error ? query.error.message : t("projectSettings.loadFailed")}
          </div>
        ) : (
          <>
            {banner && (
              <div
                className={`alert alert-${banner.type === "success" ? "success" : "error"}`}
                role="alert"
              >
                {banner.text}
              </div>
            )}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <div className="form-field">
                <label htmlFor="project-verification-mode">
                  {t("projectSettings.verificationMode")}
                </label>
                <select
                  id="project-verification-mode"
                  className="select"
                  value={verificationMode}
                  onChange={(event) =>
                    setVerificationMode(event.target.value as "human" | "rule")
                  }
                >
                  <option value="human">{t("setup.modeHuman")}</option>
                  <option value="rule">{t("setup.modeRule")}</option>
                </select>
              </div>

              <div className="form-field">
                <span>{t("projectSettings.execTargets")}</span>
                <span className="field-hint">{t("projectSettings.execTargetsHint")}</span>
              </div>
              <div className="form-field">
                <label htmlFor="exec-owner">{t("projectSettings.owner")}</label>
                <input
                  id="exec-owner"
                  className="input input-mono"
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                  placeholder="acme"
                />
              </div>
              <div className="form-field">
                <label htmlFor="exec-repo">{t("projectSettings.repo")}</label>
                <input
                  id="exec-repo"
                  className="input input-mono"
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder="etl-jobs"
                />
              </div>
              <div className="form-field">
                <label htmlFor="exec-workflows">{t("projectSettings.workflows")}</label>
                <input
                  id="exec-workflows"
                  className="input input-mono"
                  value={workflows}
                  onChange={(event) => setWorkflows(event.target.value)}
                  placeholder="normalize.yml, publish.yml"
                />
                <span className="field-hint">{t("projectSettings.workflowsHint")}</span>
              </div>

              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={onClose}
                  disabled={save.isPending}
                >
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>
                  {save.isPending ? t("common.loading") : t("common.save")}
                </button>
              </div>
            </form>

            {project && (
              <div className="project-danger-zone">
                <div className="section-subtitle">
                  <AlertTriangle size={13} aria-hidden="true" />
                  <span>{t("projectArchive.title")}</span>
                </div>
                <p className="field-hint">{t("projectArchive.intro")}</p>

                {!archiveExpanded ? (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => setArchiveExpanded(true)}
                  >
                    <Archive size={13} aria-hidden="true" />
                    <span>{t("projectArchive.action")}</span>
                  </button>
                ) : (
                  <div className="archive-confirm-box">
                    <div className="form-field">
                      <label htmlFor="archive-confirm-slug">
                        {t("projectArchive.confirmSlugLabel", { slug: project.slug })}
                      </label>
                      <input
                        id="archive-confirm-slug"
                        className="input input-mono"
                        value={archiveSlug}
                        onChange={(event) => setArchiveSlug(event.target.value)}
                        placeholder={project.slug}
                        autoComplete="off"
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="archive-reason">{t("projectArchive.reason")}</label>
                      <textarea
                        id="archive-reason"
                        className="input"
                        rows={2}
                        value={archiveReason}
                        onChange={(event) => setArchiveReason(event.target.value)}
                        placeholder={t("projectArchive.reasonPlaceholder")}
                      />
                    </div>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={archive.isPending}
                        onClick={() => {
                          setArchiveExpanded(false);
                          setArchiveSlug("");
                          setArchiveReason("");
                        }}
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={archive.isPending || archiveSlug.trim() !== project.slug}
                        onClick={() => archive.mutate()}
                      >
                        {archive.isPending
                          ? t("common.loading")
                          : t("projectArchive.confirm")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

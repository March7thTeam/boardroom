import React, { useState } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { useI18n } from "../i18n";
import type { Project } from "../types";

type ProjectTokenNoticeProps = {
  project: Pick<Project, "name" | "slug">;
  token: string;
  /** Explicit acknowledgement; the dialog never dismisses on backdrop/Escape to avoid losing the token. */
  onDismiss: () => void;
  /** Optional overrides for re-issuing a token after the initial creation flow. */
  title?: string;
  intro?: string;
  dismissLabel?: string;
};

/**
 * One-time Agent enrollment token dialog. Shown after a project is created so
 * the token cannot be destroyed by list refreshes or component unmounts.
 */
export function ProjectTokenNotice({
  project,
  token,
  onDismiss,
  title,
  intro,
  dismissLabel,
}: ProjectTokenNoticeProps): React.ReactElement {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
    } catch {
      // Fallback for environments where the Clipboard API is restricted.
      const textarea = document.createElement("textarea");
      textarea.value = token;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="modal-backdrop token-notice-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-token-notice-title"
    >
      <div className="panel-card modal-card token-notice-card">
        <div className="panel-header">
          <h2 id="project-token-notice-title" className="dock-panel-heading">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>{title ?? t("project.tokenTitle", { name: project.name })}</span>
          </h2>
        </div>
        <div className="panel-body">
          <p className="helper-text">
            {intro ?? t("project.tokenIntro", { slug: project.slug })}
          </p>
          <div
            className="token-box"
            role="region"
            aria-label={t("project.tokenLabel")}
          >
            <code>{token}</code>
          </div>
          <p className="helper-text token-warning">{t("project.tokenWarning")}</p>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleCopy()}
              autoFocus
            >
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              <span>{copied ? t("project.tokenCopied") : t("project.copyToken")}</span>
            </button>
            <button type="button" className="btn btn-primary" onClick={onDismiss}>
              {dismissLabel ?? t("project.openBoard")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

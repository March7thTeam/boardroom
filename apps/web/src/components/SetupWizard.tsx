import React, { useMemo, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";
import type { SetupInput, SetupResponse } from "../types";
import { ProjectTokenNotice } from "./ProjectTokenNotice";

type SetupWizardProps = {
  onComplete: () => void;
  completedResult?: SetupResponse | null;
  onTokenReady?: (result: SetupResponse) => void;
};

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  if (!base) return "";
  return /^[a-z]/.test(base) ? base : `p-${base}`.slice(0, 30);
}

export function SetupWizard({ onComplete, completedResult, onTokenReady }: SetupWizardProps): React.ReactElement {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [instanceName, setInstanceName] = useState("Boardroom");

  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState("");

  const [createProject, setCreateProject] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [projectSlugTouched, setProjectSlugTouched] = useState(false);
  const [verificationMode, setVerificationMode] = useState<"human" | "rule">("human");
  const [localResult, setLocalResult] = useState<SetupResponse | null>(null);
  const setupResult = completedResult ?? localResult;

  const steps = useMemo(
    () => [
      t("setup.step.instance"),
      t("setup.step.admin"),
      t("setup.step.project"),
      t("setup.step.review"),
    ],
    [t],
  );

  const effectiveSlug = projectSlugTouched ? projectSlug : slugify(projectName);

  if (setupResult?.project && setupResult.enrollment_token) {
    return (
      <ProjectTokenNotice
        project={setupResult.project}
        token={setupResult.enrollment_token}
        onDismiss={onComplete}
      />
    );
  }

  const validateStep = (index: number): string | null => {
    if (index === 0 && !instanceName.trim()) return t("setup.instanceName");
    if (index === 1) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim())) {
        return t("setup.emailRequired");
      }
      if (adminPassword.length < 10) return t("setup.passwordTooShort");
      if (adminPassword !== adminPasswordConfirm) return t("setup.passwordMismatch");
    }
    if (index === 2 && createProject) {
      if (!projectName.trim() || !/^[a-z][a-z0-9-]{1,30}$/.test(effectiveSlug)) {
        return t("setup.projectRequired");
      }
    }
    return null;
  };

  const goNext = () => {
    const validationError = validateStep(step);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setStep((value) => Math.min(value + 1, steps.length - 1));
  };

  const goBack = () => {
    setError(null);
    setStep((value) => Math.max(value - 1, 0));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = validateStep(1) ?? validateStep(2);
    if (validationError) {
      setError(validationError);
      return;
    }

    const input: SetupInput = {
      instance_name: instanceName.trim(),
      admin: {
        email: adminEmail.trim(),
        password: adminPassword,
        ...(adminName.trim() ? { display_name: adminName.trim() } : {}),
      },
      ...(createProject
        ? {
            project: {
              slug: effectiveSlug,
              name: projectName.trim(),
              verification_mode: verificationMode,
            },
          }
        : {}),
    };

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.setup(input);
      setAdminPassword("");
      setAdminPasswordConfirm("");
      if (result.project && result.enrollment_token) {
        // Keep the one-time token on screen instead of discarding it on redirect.
        setLocalResult(result);
        onTokenReady?.(result);
      } else {
        onComplete();
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.code})`
          : err instanceof Error
            ? err.message
            : t("setup.failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="setup-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            <LayoutGrid size={18} />
          </span>
          <div>
            <div className="auth-brand-title">{t("app.brandTitle")}</div>
            <div className="auth-brand-sub">{t("app.brandSubtitle")}</div>
          </div>
        </div>

        <h1 className="auth-title">{t("setup.title")}</h1>
        <p className="auth-subtitle">{t("setup.subtitle")}</p>

        <ol className="setup-steps" aria-label={t("setup.title")}>
          {steps.map((label, index) => (
            <li
              key={label}
              className={`setup-step ${index === step ? "is-current" : ""} ${
                index < step ? "is-done" : ""
              }`}
              aria-current={index === step ? "step" : undefined}
            >
              <span className="setup-step-number">{index + 1}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {step === 0 && (
            <div className="setup-body">
              <label className="form-field">
                <span>{t("setup.instanceName")}</span>
                <input
                  className="input"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                  maxLength={80}
                  required
                  autoFocus
                />
                <small className="field-hint">{t("setup.instanceNameHint")}</small>
              </label>
            </div>
          )}

          {step === 1 && (
            <div className="setup-body">
              <label className="form-field">
                <span>{t("setup.adminEmail")}</span>
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  required
                  autoFocus
                />
              </label>
              <label className="form-field">
                <span>{t("setup.adminName")}</span>
                <input
                  className="input"
                  autoComplete="name"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  maxLength={120}
                />
              </label>
              <label className="form-field">
                <span>{t("setup.adminPassword")}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                />
                <small className="field-hint">{t("setup.adminPasswordHint")}</small>
              </label>
              <label className="form-field">
                <span>{t("setup.adminPasswordConfirm")}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={adminPasswordConfirm}
                  onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                  required
                />
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="setup-body">
              <label className="setup-checkbox">
                <input
                  type="checkbox"
                  checked={createProject}
                  onChange={(e) => setCreateProject(e.target.checked)}
                />
                <span>{t("setup.createProject")}</span>
              </label>

              {createProject && (
                <>
                  <label className="form-field">
                    <span>{t("setup.projectName")}</span>
                    <input
                      className="input"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      maxLength={120}
                      required
                      autoFocus
                    />
                  </label>
                  <label className="form-field">
                    <span>{t("setup.projectSlug")}</span>
                    <input
                      className="input input-mono"
                      value={effectiveSlug}
                      onChange={(e) => {
                        setProjectSlugTouched(true);
                        setProjectSlug(e.target.value.toLowerCase());
                      }}
                      maxLength={31}
                      required
                    />
                    <small className="field-hint">{t("setup.projectSlugHint")}</small>
                  </label>
                  <label className="form-field">
                    <span>{t("setup.verificationMode")}</span>
                    <select
                      className="select"
                      value={verificationMode}
                      onChange={(e) => setVerificationMode(e.target.value as "human" | "rule")}
                    >
                      <option value="human">{t("setup.modeHuman")}</option>
                      <option value="rule">{t("setup.modeRule")}</option>
                    </select>
                  </label>
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="setup-body">
              <dl className="setup-review">
                <dt>{t("setup.reviewInstance")}</dt>
                <dd>{instanceName}</dd>
                <dt>{t("setup.reviewAdmin")}</dt>
                <dd>
                  {adminName ? `${adminName} · ` : ""}
                  {adminEmail}
                </dd>
                <dt>{t("setup.reviewProject")}</dt>
                <dd>
                  {createProject
                    ? `${projectName} (${effectiveSlug}) · ${
                        verificationMode === "human" ? t("setup.modeHuman") : t("setup.modeRule")
                      }`
                    : t("setup.reviewNone")}
                </dd>
              </dl>
            </div>
          )}

          <div className="setup-actions">
            {step > 0 && (
              <button type="button" className="btn btn-secondary" onClick={goBack} disabled={submitting}>
                {t("setup.back")}
              </button>
            )}
            <span className="setup-spacer" />
            {step === 2 && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setCreateProject(false);
                  setStep(3);
                }}
                disabled={submitting}
              >
                {t("setup.skipProject")}
              </button>
            )}
            {step < steps.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={goNext} disabled={submitting}>
                {t("setup.next")}
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? t("setup.submitting") : t("setup.submit")}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

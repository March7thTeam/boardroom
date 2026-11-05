import React, { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";

type ChangePasswordPageProps = {
  onDone: () => void;
};

export function ChangePasswordPage({ onDone }: ChangePasswordPageProps): React.ReactElement {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (newPassword.length < 10) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("auth.passwordMismatch"));
      return;
    }

    setSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setDone(true);
      window.setTimeout(onDone, 900);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.code})`
          : err instanceof Error
            ? err.message
            : t("auth.failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            <LayoutGrid size={18} />
          </span>
          <div>
            <div className="auth-brand-title">{t("app.brandTitle")}</div>
            <div className="auth-brand-sub">{t("app.brandSubtitle")}</div>
          </div>
        </div>

        <h1 className="auth-title">{t("auth.changeTitle")}</h1>
        <p className="auth-subtitle">{t("auth.changeSubtitle")}</p>

        {done ? (
          <div className="alert alert-success" role="status">
            {t("auth.changedRelogin")}
          </div>
        ) : (
          <>
            {error && (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            )}

            <label className="form-field">
              <span>{t("auth.currentPassword")}</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoFocus
              />
            </label>

            <label className="form-field">
              <span>{t("auth.newPassword")}</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </label>

            <label className="form-field">
              <span>{t("auth.confirmPassword")}</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </label>

            <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
              {submitting ? t("common.loading") : t("auth.changePassword")}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

import React, { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";

type LoginPageProps = {
  needsBootstrap: boolean;
  onAuthenticated: () => void;
};

export function LoginPage({ needsBootstrap, onAuthenticated }: LoginPageProps): React.ReactElement {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isBootstrap = needsBootstrap;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (isBootstrap) {
      if (password.length < 10) {
        setError(t("auth.passwordTooShort"));
        return;
      }
      if (password !== confirmPassword) {
        setError(t("auth.passwordMismatch"));
        return;
      }
    }

    setSubmitting(true);
    try {
      if (isBootstrap) {
        await api.bootstrap(email, password, displayName);
      } else {
        await api.login(email, password);
      }
      onAuthenticated();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.message} (${err.code})`
          : err instanceof Error
            ? err.message
            : t("auth.failed");
      setError(message);
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

        <h1 className="auth-title">
          {isBootstrap ? t("auth.bootstrapTitle") : t("auth.loginTitle")}
        </h1>
        <p className="auth-subtitle">
          {isBootstrap ? t("auth.bootstrapSubtitle") : t("auth.loginSubtitle")}
        </p>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <label className="form-field">
          <span>{t("auth.email")}</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>

        {isBootstrap && (
          <label className="form-field">
            <span>{t("auth.displayName")}</span>
            <input
              className="input"
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
        )}

        <label className="form-field">
          <span>{t("auth.password")}</span>
          <input
            className="input"
            type="password"
            autoComplete={isBootstrap ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {isBootstrap && (
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
        )}

        <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
          {submitting
            ? t("common.loading")
            : isBootstrap
              ? t("auth.createAdmin")
              : t("auth.signIn")}
        </button>

        {isBootstrap && <p className="auth-hint">{t("auth.bootstrapHint")}</p>}
      </form>
    </div>
  );
}

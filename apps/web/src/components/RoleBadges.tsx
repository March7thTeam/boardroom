import React from "react";
import { Crown, ShieldCheck } from "lucide-react";
import { useI18n } from "../i18n";
import type { ProjectSummary } from "../types";

/**
 * Role naming (issue #14): instance-level and project-level roles must never
 * share a label. Instance admins get a distinct shield badge; project roles
 * read as "project owner / project member".
 */
export function InstanceRoleBadge({ role }: { role: "admin" | "member" }): React.ReactElement {
  const { t } = useI18n();
  if (role === "admin") {
    return (
      <span className="badge badge-instance-admin">
        <ShieldCheck size={11} aria-hidden="true" />
        {t("roles.instanceAdmin")}
      </span>
    );
  }
  return <span className="badge badge-neutral">{t("roles.instanceUser")}</span>;
}

export function ProjectRoleBadge({
  role,
  access = "member",
}: {
  role: ProjectSummary["role"];
  access?: ProjectSummary["access"];
}): React.ReactElement {
  const { t } = useI18n();
  if (access === "admin") {
    return (
      <span className="badge badge-instance-admin" title={t("roles.adminAccessHint")}>
        <ShieldCheck size={11} aria-hidden="true" />
        {t("roles.adminAccess")}
      </span>
    );
  }
  if (role === "owner") {
    return (
      <span className="badge badge-project-owner">
        <Crown size={11} aria-hidden="true" />
        {t("participants.roleOwner")}
      </span>
    );
  }
  return <span className="badge badge-neutral">{t("participants.roleMember")}</span>;
}

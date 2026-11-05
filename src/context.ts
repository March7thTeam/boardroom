import type { AuthPrincipal } from "./lib/session";
import type { AgentRow, ProjectRow, UserRow } from "./types";
import type { Env } from "./types";
import type { Locale, TranslateFn } from "./i18n";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    user: UserRow;
    principal: AuthPrincipal;
    agent: AgentRow;
    /**
     * The only project the presented agent token is bound to.
     */
    agentCredentialProject: string;
    project: ProjectRow;
    projectRole: "owner" | "member";
    /** `admin` when the caller reaches the project only as an instance admin. */
    projectAccess: "member" | "admin";
    locale: Locale;
    t: TranslateFn;
  };
};

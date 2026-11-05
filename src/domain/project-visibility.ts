import { isAdmin } from "../middleware/identity";
import type { ProjectRow, UserRow } from "../types";

export type ProjectAccess = "member" | "admin";

export type VisibleProjectRow = ProjectRow & {
  role: "owner" | "member";
  access: ProjectAccess;
};

/**
 * Projects a user can open, using the same rule as `requireProjectMember`
 * (issue #5): every membership, plus — for instance admins — every other
 * unarchived project as an implicit owner (`access = "admin"`).
 */
export async function listVisibleProjects(db: D1Database, user: UserRow): Promise<VisibleProjectRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.*,
              COALESCE(pm.role, 'owner') AS role,
              CASE WHEN pm.user_id IS NULL THEN 'admin' ELSE 'member' END AS access
         FROM projects p
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?1
        WHERE p.archived_at IS NULL
          AND (pm.user_id IS NOT NULL OR ?2 = 1)
        ORDER BY p.created_at DESC`,
    )
    .bind(user.id, isAdmin(user) ? 1 : 0)
    .all<VisibleProjectRow>();
  return rows.results;
}

import { Hono } from "hono";
import type { AppEnv } from "../context";
import { listVisibleProjects } from "../domain/project-visibility";
import { requireUser } from "../middleware/identity";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", requireUser, async (c) => {
  const user = c.get("user");
  // Same visibility rule as GET /projects and requireProjectMember (issue #5).
  const projects = (await listVisibleProjects(c.env.DB, user)).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    access: row.access,
  }));

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      status: user.status,
      must_change_password: user.must_change_password === 1,
    },
    projects,
  });
});

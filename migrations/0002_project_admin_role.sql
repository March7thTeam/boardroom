-- 0002: add a project-level admin role.
--
-- Project roles are now owner / admin / member. `owner` remains unique per
-- project (uq_project_single_owner); `admin` is a delegated manager who can use
-- governance actions but cannot transfer ownership or manage members.
--
-- SQLite cannot alter a CHECK constraint in place, so rebuild the table while
-- preserving membership rows, then recreate its indexes.
CREATE TABLE project_members_v2 (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  added_by   TEXT NOT NULL REFERENCES users(id),
  added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, user_id)
);

INSERT INTO project_members_v2 (project_id, user_id, role, added_by, added_at)
SELECT project_id, user_id, role, added_by, added_at FROM project_members;

DROP TABLE project_members;
ALTER TABLE project_members_v2 RENAME TO project_members;

CREATE INDEX idx_members_user ON project_members(user_id);
CREATE UNIQUE INDEX uq_project_single_owner ON project_members(project_id) WHERE role = 'owner';

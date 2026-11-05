import { randomSecret, tokenHash } from "./crypto";
import { newId } from "./ids";
import { addDaysIso, nowIso } from "./time";
import { formatEnrollmentToken } from "./tokens";

/** Create a 90-day project enrollment token; the plaintext is returned once. */
export async function issueEnrollmentToken(
  db: D1Database,
  projectId: string,
  createdBy: string,
  pepper: string,
  rotateExisting = false,
): Promise<string> {
  const secret = randomSecret();
  const token = formatEnrollmentToken(projectId, secret);
  const statement = db.prepare(
      `INSERT INTO project_tokens
         (id, project_id, prefix, hash, max_agents, expires_at, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      newId("ptk"),
      projectId,
      token.slice(0, 12),
      await tokenHash(secret, pepper),
      50,
      addDaysIso(90),
      createdBy,
      nowIso(),
    );
  if (rotateExisting) {
    await db.batch([
      db.prepare("UPDATE project_tokens SET revoked_at = ?1 WHERE project_id = ?2 AND revoked_at IS NULL").bind(nowIso(), projectId),
      statement,
    ]);
  } else await statement.run();
  return token;
}

/** The same permanent gate protects both first-run endpoints in their D1 batch. */
export function bootstrapClaim(db: D1Database, claimId: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO instance_settings (k, v)
     VALUES ('bootstrap_claim', CASE WHEN NOT EXISTS (SELECT 1 FROM users) THEN ?1 ELSE NULL END)`,
  ).bind(claimId);
}

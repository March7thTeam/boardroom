export const RESOLVED_AGENT_NAME_SQL =
  "COALESCE(NULLIF(a.display_name,''), NULLIF(a.self_reported_name,''), a.id, a.harness || ' agent')";

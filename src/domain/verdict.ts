export interface AcceptanceCriterion {
  key: string;
  op: "eq" | "gte" | "lte" | "matches" | "exists";
  value?: unknown;
  severity?: "block" | "warn";
}

export interface VerdictReason {
  key: string;
  op: AcceptanceCriterion["op"];
  expected?: unknown;
  actual?: unknown;
  pass: boolean;
  severity: "block" | "warn";
}

export interface CriteriaEvaluation {
  pass: boolean;
  reasons: VerdictReason[];
  /** Always true in S2: the values come from the Agent's self_check, not re-computed artifacts. */
  self_reported: true;
}

export function evaluateCriteria(
  criteriaJson: string | null | undefined,
  selfCheck: Array<{ key: string; value?: unknown }> | undefined,
): CriteriaEvaluation {
  let criteria: AcceptanceCriterion[] = [];
  if (criteriaJson) {
    try {
      const parsed = JSON.parse(criteriaJson);
      if (Array.isArray(parsed)) {
        criteria = parsed.filter((item): item is AcceptanceCriterion => {
          return Boolean(
            item &&
              typeof item === "object" &&
              typeof (item as AcceptanceCriterion).key === "string" &&
              typeof (item as AcceptanceCriterion).op === "string",
          );
        });
      }
    } catch {
      criteria = [];
    }
  }

  const values = new Map<string, unknown>();
  for (const item of selfCheck ?? []) {
    if (item && typeof item.key === "string") values.set(item.key, item.value);
  }

  const reasons = criteria.map((criterion): VerdictReason => {
    const actual = values.get(criterion.key);
    const severity = criterion.severity ?? "block";
    let pass = false;
    switch (criterion.op) {
      case "eq":
        pass = JSON.stringify(actual) === JSON.stringify(criterion.value);
        break;
      case "gte":
        pass =
          typeof actual === "number" &&
          typeof criterion.value === "number" &&
          actual >= criterion.value;
        break;
      case "lte":
        pass =
          typeof actual === "number" &&
          typeof criterion.value === "number" &&
          actual <= criterion.value;
        break;
      case "matches": {
        if (typeof actual === "string" && typeof criterion.value === "string") {
          try {
            pass = new RegExp(criterion.value).test(actual);
          } catch {
            pass = false;
          }
        }
        break;
      }
      case "exists":
        pass = actual !== undefined && actual !== null;
        break;
    }
    return {
      key: criterion.key,
      op: criterion.op,
      expected: criterion.value,
      actual,
      pass,
      severity,
    };
  });

  const pass = reasons.every((reason) => reason.pass || reason.severity === "warn");
  return { pass, reasons, self_reported: true };
}

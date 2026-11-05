export function nowIso(): string {
  return new Date().toISOString();
}

export function addDaysIso(days: number, from = new Date()): string {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function addMinutesIso(minutes: number, from = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

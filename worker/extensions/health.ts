/**
 * Source health.
 *
 * Every provider call is wrapped so that a failure is recorded rather than
 * propagated -- the catalog needs to know *that* a source failed and move on,
 * and the Extension Manager needs to show why. State lives in the isolate,
 * which is the right lifetime for it: it is a hint for routing and display, not
 * a fact worth persisting, and it costs no storage round-trip on a hot path.
 */
export interface HealthRecord {
  id: string;
  ok: number;
  failed: number;
  lastOkAt?: number;
  lastFailedAt?: number;
  lastError?: string;
  lastErrorKind?: string;
  lastLatencyMs?: number;
}

const health = new Map<string, HealthRecord>();

const record = (id: string): HealthRecord => {
  let r = health.get(id);
  if (!r) {
    r = { id, ok: 0, failed: 0 };
    health.set(id, r);
  }
  return r;
};

export function noteSuccess(id: string, latencyMs: number): void {
  const r = record(id);
  r.ok += 1;
  r.lastOkAt = Date.now();
  r.lastLatencyMs = latencyMs;
}

export function noteFailure(id: string, error: unknown): void {
  const r = record(id);
  r.failed += 1;
  r.lastFailedAt = Date.now();
  r.lastError = String((error as any)?.message ?? error).slice(0, 300);
  r.lastErrorKind = String((error as any)?.kind ?? 'error');
}

export const getHealth = (id: string): HealthRecord | undefined => health.get(id);
export const allHealth = (): HealthRecord[] => [...health.values()];

/** Run a provider call, timing it and recording the outcome either way. */
export async function tracked<T>(id: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    noteSuccess(id, Date.now() - started);
    return result;
  } catch (error) {
    noteFailure(id, error);
    throw error;
  }
}

/** A source that has only ever failed, recently, is worth trying last. */
export function isLikelyDown(id: string): boolean {
  const r = health.get(id);
  if (!r || !r.lastFailedAt) return false;
  const recent = Date.now() - r.lastFailedAt < 60_000;
  return recent && r.failed >= 2 && (r.lastOkAt ?? 0) < r.lastFailedAt;
}

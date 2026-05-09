/**
 * Working-days arithmetic for PRD windows (§5.2.2 grace period, §6.1 voting
 * windows where required, etc.).
 *
 * Working days = Mon–Fri. v1 has no public-holiday calendar; firms with
 * jurisdiction-specific holidays will get those in a Phase 2 calendar service.
 * The function is jurisdiction-agnostic so the call sites won't change.
 */
export function addWorkingDays(from: Date, days: number): Date {
  const out = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    const dow = out.getUTCDay(); // 0 = Sun, 6 = Sat
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return out;
}

"use client";

import { useState, useTransition } from "react";

/**
 * Render a base32 secret in space-separated groups of four so a human can
 * transcribe it into an authenticator app. Inlined here (not imported from
 * `@/lib/auth/totp/secret`) because that module also exports
 * `generateSecret()` which pulls in `node:crypto` — that path is fine
 * server-side but breaks the client webpack bundle.
 */
function formatForDisplay(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

type Status = {
  enrolled: boolean;
  recoveryCodesRemaining: number;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
};

type InitiationResult = {
  secretBase32: string;
  otpauthUri: string;
  recoveryCodes: string[];
};

type RegenerateResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: string };

type ServerActions = {
  initiate: () => Promise<InitiationResult>;
  confirm: (code: string) => Promise<{ ok: boolean; reason?: string }>;
  disable: (code: string) => Promise<{ ok: boolean; reason?: string }>;
  regenerateRecovery: (code: string) => Promise<RegenerateResult>;
};

export function TwoFactorCard({
  status,
  tenantRequireTotp,
  actions,
  copy,
}: {
  status: Status;
  tenantRequireTotp: boolean;
  actions: ServerActions;
  copy: {
    heading: string;
    enrolledDescription: string;
    notEnrolledDescription: string;
    enforcedNote: string;
    enrolledOn: string;
    lastUsed: string;
    recoveryRemaining: string;
    enableButton: string;
    disableButton: string;
    cancel: string;
    secretLabel: string;
    otpauthLabel: string;
    enterCodeLabel: string;
    submitCode: string;
    recoveryHeading: string;
    recoveryWarning: string;
    enrollFailed: string;
    disableConfirm: string;
    disableFailed: string;
    never: string;
    regenerateButton: string;
    regenerateDescription: string;
    regenerateHeading: string;
    regenerateSuccess: string;
    regenerateFailed: string;
  };
}) {
  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "enrolling"; initiation: InitiationResult; code: string; error: string | null }
    | { kind: "post-enrolled"; recoveryCodes: string[] }
    | { kind: "disabling"; code: string; error: string | null }
    | { kind: "regenerating-recovery"; code: string; error: string | null }
    | { kind: "post-regenerated"; recoveryCodes: string[] }
  >({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const beginEnroll = () =>
    startTransition(async () => {
      const init = await actions.initiate();
      setPhase({ kind: "enrolling", initiation: init, code: "", error: null });
    });

  const submitEnroll = () =>
    startTransition(async () => {
      if (phase.kind !== "enrolling") return;
      const res = await actions.confirm(phase.code);
      if (res.ok) {
        setPhase({ kind: "post-enrolled", recoveryCodes: phase.initiation.recoveryCodes });
      } else {
        setPhase({ ...phase, error: copy.enrollFailed });
      }
    });

  const cancelEnroll = () => setPhase({ kind: "idle" });

  const beginDisable = () => setPhase({ kind: "disabling", code: "", error: null });

  const beginRegenerate = () =>
    setPhase({ kind: "regenerating-recovery", code: "", error: null });

  const submitRegenerate = () =>
    startTransition(async () => {
      if (phase.kind !== "regenerating-recovery") return;
      const res = await actions.regenerateRecovery(phase.code);
      if (res.ok) {
        setPhase({ kind: "post-regenerated", recoveryCodes: res.recoveryCodes });
      } else {
        setPhase({ ...phase, error: copy.regenerateFailed });
      }
    });

  const submitDisable = () =>
    startTransition(async () => {
      if (phase.kind !== "disabling") return;
      const res = await actions.disable(phase.code);
      if (res.ok) {
        setPhase({ kind: "idle" });
      } else {
        setPhase({ ...phase, error: copy.disableFailed });
      }
    });

  return (
    <div className="card space-y-3">
      <h2 className="text-base font-medium">{copy.heading}</h2>
      <p className="text-sm text-ink/70">
        {status.enrolled ? copy.enrolledDescription : copy.notEnrolledDescription}
      </p>
      {tenantRequireTotp && !status.enrolled && (
        <div className="rounded border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
          {copy.enforcedNote}
        </div>
      )}

      {status.enrolled && phase.kind === "idle" && (
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">{copy.enrolledOn}</dt>
            <dd>{status.verifiedAt?.toISOString().slice(0, 10) ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">{copy.lastUsed}</dt>
            <dd>
              {status.lastUsedAt ? status.lastUsedAt.toISOString().slice(0, 10) : copy.never}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-ink/50">
              {copy.recoveryRemaining}
            </dt>
            <dd>{status.recoveryCodesRemaining}</dd>
          </div>
        </dl>
      )}

      {phase.kind === "idle" && (
        <div className="flex flex-wrap justify-end gap-2">
          {!status.enrolled ? (
            <button type="button" className="btn btn-primary text-sm" onClick={beginEnroll} disabled={pending}>
              {copy.enableButton}
            </button>
          ) : (
            <>
              <button type="button" className="btn text-sm" onClick={beginRegenerate} disabled={pending}>
                {copy.regenerateButton}
              </button>
              <button type="button" className="btn text-sm" onClick={beginDisable} disabled={pending}>
                {copy.disableButton}
              </button>
            </>
          )}
        </div>
      )}

      {phase.kind === "enrolling" && (
        <div className="space-y-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-ink/50">{copy.secretLabel}</div>
            <code className="mt-1 block break-all rounded bg-ink/5 p-2 font-mono text-sm">
              {formatForDisplay(phase.initiation.secretBase32)}
            </code>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-ink/60 hover:text-ink/80">
              {copy.otpauthLabel}
            </summary>
            <code className="mt-1 block break-all rounded bg-ink/5 p-2 font-mono text-[11px]">
              {phase.initiation.otpauthUri}
            </code>
          </details>
          <div>
            <label className="label" htmlFor="totp-enroll-code">
              {copy.enterCodeLabel}
            </label>
            <input
              id="totp-enroll-code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={phase.code}
              onChange={(e) =>
                setPhase({ ...phase, code: e.target.value.replace(/\D/g, "").slice(0, 6) })
              }
            />
            {phase.error && <p className="mt-1 text-xs text-red-700">{phase.error}</p>}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-xs text-ink/60 underline" onClick={cancelEnroll}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="btn btn-primary text-sm"
              onClick={submitEnroll}
              disabled={pending || phase.code.length !== 6}
            >
              {copy.submitCode}
            </button>
          </div>
        </div>
      )}

      {phase.kind === "post-enrolled" && (
        <div className="space-y-2">
          <div className="rounded border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-900">
            {copy.recoveryHeading}
          </div>
          <p className="text-xs text-ink/70">{copy.recoveryWarning}</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
            {phase.recoveryCodes.map((c) => (
              <li key={c} className="rounded bg-ink/5 px-2 py-1">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button type="button" className="btn text-sm" onClick={() => setPhase({ kind: "idle" })}>
              {copy.cancel}
            </button>
          </div>
        </div>
      )}

      {phase.kind === "regenerating-recovery" && (
        <div className="space-y-3">
          <p className="text-sm text-ink/70">{copy.regenerateDescription}</p>
          <div>
            <label className="label" htmlFor="totp-regen-code">
              {copy.enterCodeLabel}
            </label>
            <input
              id="totp-regen-code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={phase.code}
              onChange={(e) =>
                setPhase({ ...phase, code: e.target.value.replace(/\D/g, "").slice(0, 6) })
              }
            />
            {phase.error && <p className="mt-1 text-xs text-red-700">{phase.error}</p>}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs text-ink/60 underline"
              onClick={() => setPhase({ kind: "idle" })}
            >
              {copy.cancel}
            </button>
            <button
              type="button"
              className="btn btn-primary text-sm"
              onClick={submitRegenerate}
              disabled={pending || phase.code.length !== 6}
            >
              {copy.submitCode}
            </button>
          </div>
        </div>
      )}

      {phase.kind === "post-regenerated" && (
        <div className="space-y-2">
          <div className="rounded border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-900">
            {copy.regenerateSuccess}
          </div>
          <p className="text-xs text-ink/70">{copy.recoveryWarning}</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
            {phase.recoveryCodes.map((c) => (
              <li key={c} className="rounded bg-ink/5 px-2 py-1">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button type="button" className="btn text-sm" onClick={() => setPhase({ kind: "idle" })}>
              {copy.cancel}
            </button>
          </div>
        </div>
      )}

      {phase.kind === "disabling" && (
        <div className="space-y-3">
          <p className="text-sm text-ink/70">{copy.disableConfirm}</p>
          <div>
            <label className="label" htmlFor="totp-disable-code">
              {copy.enterCodeLabel}
            </label>
            <input
              id="totp-disable-code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={20}
              value={phase.code}
              onChange={(e) => setPhase({ ...phase, code: e.target.value.slice(0, 20) })}
            />
            {phase.error && <p className="mt-1 text-xs text-red-700">{phase.error}</p>}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs text-ink/60 underline"
              onClick={() => setPhase({ kind: "idle" })}
            >
              {copy.cancel}
            </button>
            <button
              type="button"
              className="btn btn-primary text-sm"
              onClick={submitDisable}
              disabled={pending || phase.code.length < 6}
            >
              {copy.disableButton}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

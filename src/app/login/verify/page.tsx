import { cookies } from "next/headers";
import Link from "next/link";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const email = (await cookies()).get("acumon_login_email")?.value ?? "";

  if (!email) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-2xl font-semibold tracking-tight">No pending sign-in</h1>
        <p className="mt-2 text-sm text-ink/70">
          Start over: <Link href="/login">/login</Link>.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Enter your code</h1>
      <p className="mt-2 text-sm text-ink/70">
        We&apos;ve sent a 6-digit code to{" "}
        <span className="font-medium">{email}</span>. Enter it below.
      </p>

      {sp.error && (
        <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
          {sp.error === "Verification"
            ? "That code didn't match (or has expired). Request a new one and try again."
            : `Verification failed: ${sp.error}.`}
        </p>
      )}

      <form className="mt-6 space-y-3" method="GET" action="/api/auth/callback/nodemailer">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="callbackUrl" value="/" />
        <label className="label">6-digit code</label>
        <input
          className="input text-center text-2xl tracking-[0.4em] font-mono"
          name="token"
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          autoComplete="one-time-code"
        />
        <button className="btn btn-primary w-full" type="submit">
          Verify &amp; sign in
        </button>
      </form>

      <p className="mt-6 text-xs text-ink/50">
        Didn&apos;t receive it? Check spam, or <Link href="/login">request a new code</Link>. Codes
        expire after 10 minutes.
      </p>
    </main>
  );
}

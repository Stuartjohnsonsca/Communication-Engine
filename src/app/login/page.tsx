import { signIn } from "@/lib/auth";

export default function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  return <LoginInner searchParams={searchParams} />;
}

async function LoginInner({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const hasEmailServer = !!process.env.EMAIL_SERVER && !!process.env.EMAIL_FROM;
  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-ink/70">
        We&apos;ll email you a one-time link. No password.
      </p>

      {sp.error && (
        <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
          Sign-in failed: {sp.error}. Check your email server config.
        </p>
      )}

      {!hasEmailServer && (
        <p className="mt-4 rounded bg-amber-50 p-3 text-sm text-amber-800">
          No <code>EMAIL_SERVER</code> configured — magic-link is disabled. Set
          <code> EMAIL_SERVER</code> and <code>EMAIL_FROM</code> in your environment, or
          seed a session manually for local development.
        </p>
      )}

      {hasEmailServer && (
        <form
          className="mt-6 space-y-3"
          action={async (formData: FormData) => {
            "use server";
            const email = String(formData.get("email") ?? "");
            await signIn("nodemailer", { email, redirectTo: "/" });
          }}
        >
          <label className="label">Email</label>
          <input className="input" name="email" type="email" required autoFocus />
          <button className="btn btn-primary w-full" type="submit">
            Send magic link
          </button>
        </form>
      )}
    </main>
  );
}

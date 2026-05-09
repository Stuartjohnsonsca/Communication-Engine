import { cookies } from "next/headers";
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
        We&apos;ll email you a 6-digit code. Enter it on the next page. No password.
      </p>

      {sp.error && (
        <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
          Sign-in failed: {sp.error}.
        </p>
      )}

      {!hasEmailServer && (
        <p className="mt-4 rounded bg-amber-50 p-3 text-sm text-amber-800">
          No <code>EMAIL_SERVER</code> configured.
        </p>
      )}

      {hasEmailServer && (
        <form
          className="mt-6 space-y-3"
          action={async (formData: FormData) => {
            "use server";
            const email = String(formData.get("email") ?? "").trim().toLowerCase();
            if (!email) return;
            // Stash the address so /login/verify can show it.
            (await cookies()).set("acumon_login_email", email, {
              path: "/",
              maxAge: 60 * 15,
              httpOnly: true,
              sameSite: "lax",
              secure: true,
            });
            // Triggers email send and redirects to pages.verifyRequest = /login/verify.
            await signIn("nodemailer", { email });
          }}
        >
          <label className="label">Email</label>
          <input className="input" name="email" type="email" required autoFocus />
          <button className="btn btn-primary w-full" type="submit">
            Send sign-in code
          </button>
        </form>
      )}
    </main>
  );
}

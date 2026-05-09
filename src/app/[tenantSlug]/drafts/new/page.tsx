import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import NewDraftClient from "./NewDraftClient";

export default async function NewDraftPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">New draft</h1>
      <p className="text-sm text-ink/70">
        Paste an inbound message. Claude will produce a draft response in your UCG voice,
        constrained by the firm&apos;s FCG, with extracted actions. Nothing is sent — sending happens
        in your real email client.
      </p>
      <NewDraftClient tenantSlug={tenantSlug} />
    </div>
  );
}

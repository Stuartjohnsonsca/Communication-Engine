import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { getNavBadges } from "@/lib/notifications";
import { buildNavTree, findNavNode } from "@/lib/nav-tree";
import { NavTilePage } from "@/components/NavTilePage";

export const dynamic = "force-dynamic";

export default async function CultureLanding({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  const tree = buildNavTree(ctx, tenantSlug);
  const node = findNavNode(tree, "culture");
  if (!node) redirect(`/${tenantSlug}/dashboard`);
  const badges = await getNavBadges({
    tenantId: ctx.tenant.id,
    tenantSlug,
    membership: ctx.membership,
  });
  return <NavTilePage node={node} badges={badges} />;
}

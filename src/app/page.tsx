import { Dashboard } from "@/components/dashboard";
import { runDemoScan } from "@/lib/patrol/demo";
import { usableSecret } from "@/lib/patrol/env";

export const dynamic = "force-dynamic";

export default async function Page() {
  const initial = await runDemoScan();
  return <Dashboard initial={initial} draftPrsEnabled={Boolean(usableSecret(process.env.GITHUB_TOKEN))} />;
}

import { NextResponse } from "next/server";
import { usableSecret } from "@/lib/patrol/env";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    draftPrsEnabled: Boolean(usableSecret(process.env.GITHUB_TOKEN)),
    defaultMode: "dry-run",
    merges: false,
  });
}

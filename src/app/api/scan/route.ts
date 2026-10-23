import { NextResponse } from "next/server";
import { runDemoScan } from "@/lib/patrol/demo";
import { usableSecret } from "@/lib/patrol/env";
import { assertOwnerRepo } from "@/lib/patrol/repos";
import { clampWindow, runLiveScan } from "@/lib/patrol/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    mode?: string;
    windowHours?: number;
    repos?: unknown;
  };
  const windowHours = clampWindow(body.windowHours);
  if (body.mode === "live") {
    const repos = Array.isArray(body.repos) ? body.repos.filter((repo): repo is string => typeof repo === "string") : [];
    if (repos.length < 1 || repos.length > 20) {
      return NextResponse.json({ error: "Pass 1 to 20 GitHub repos as owner/name." }, { status: 400 });
    }
    for (const repo of repos) {
      try {
        assertOwnerRepo(repo);
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Invalid repo." },
          { status: 400 },
        );
      }
    }
    const scan = await runLiveScan({
      repos,
      windowHours,
      token: usableSecret(process.env.GITHUB_TOKEN),
      nvdApiKey: usableSecret(process.env.NVD_API_KEY),
    });
    return NextResponse.json(scan);
  }
  const scan = await runDemoScan({ windowHours });
  return NextResponse.json(scan);
}

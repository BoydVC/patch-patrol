import { NextResponse } from "next/server";
import { planDemoFix, planLiveFix } from "@/lib/patrol/actions";
import { usableSecret } from "@/lib/patrol/env";
import { assertOwnerRepo } from "@/lib/patrol/repos";
import type { Ecosystem, PrMode } from "@/lib/patrol/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ECOSYSTEMS = new Set<Ecosystem>(["npm", "pypi", "go", "crates"]);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const mode: PrMode = body.mode === "draft" ? "draft" : "dry-run";
  try {
    if (body.origin === "live") {
      const repo = stringField(body.repo, "repo");
      assertOwnerRepo(repo);
      const ecosystem = stringField(body.ecosystem, "ecosystem") as Ecosystem;
      if (!ECOSYSTEMS.has(ecosystem)) throw new Error("Unsupported ecosystem.");
      const name = stringField(body.name, "name");
      if (name.includes("..") || !/^[A-Za-z0-9_@./+-]+$/.test(name)) {
        throw new Error("Unsupported package name.");
      }
      const targetVersion = optionalString(body.targetVersion);
      if (targetVersion && !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,60}$/.test(targetVersion)) {
        throw new Error("Unsupported target version.");
      }
      const result = await planLiveFix({
        mode,
        repo,
        ecosystem,
        name,
        targetVersion,
        direct: body.direct === true,
        title: stringField(body.title, "title").slice(0, 180),
        body: stringField(body.body, "body").slice(0, 12_000),
        token: usableSecret(process.env.GITHUB_TOKEN),
      });
      return NextResponse.json(result);
    }
    const matchId = stringField(body.matchId, "matchId");
    const result = await planDemoFix({
      matchId,
      mode,
      windowHours: typeof body.windowHours === "number" ? body.windowHours : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not build the fix plan." },
      { status: 400 },
    );
  }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${label}.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

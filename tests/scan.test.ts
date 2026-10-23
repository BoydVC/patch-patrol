import { describe, expect, it } from "vitest";
import { runDemoScan } from "../src/lib/patrol/demo";
import { renderReport } from "../src/lib/patrol/report";
import { selectRecentOsvIds } from "../src/lib/patrol/sources/osv";
import { mapCpe, nvdStamp } from "../src/lib/patrol/sources/nvd";
import { normalizeGitHubAdvisory } from "../src/lib/patrol/sources/github";
import { SocialSourceSlot } from "../src/lib/patrol/sources/social";

describe("demo scan", () => {
  it("matches the Northwind fixtures and drops records outside the window", async () => {
    const scan = await runDemoScan({ windowHours: 48 });
    expect(scan.mode).toBe("demo");
    expect(scan.clock).toBe("frozen");
    expect(scan.matches.map((match) => [match.dependency.name, match.repo, match.score.score, match.score.reachability])).toEqual([
      ["lodash", "northwind/storefront", 98, "likely"],
      ["requests", "northwind/catalog", 81, "likely"],
      ["golang.org/x/net", "northwind/relay", 75, "likely"],
      ["minimist", "northwind/storefront", 60, "possible"],
      ["idna", "northwind/edge", 52, "likely"],
      ["vitest", "northwind/storefront", 35, "possible"],
    ]);
    expect(scan.matches.find((match) => match.dependency.name === "lodash")?.score.reasons.join(" ")).toContain(
      "_.zipObjectDeep",
    );
    expect(scan.matches.some((match) => match.dependency.name === "react")).toBe(false);
    expect(scan.repos.find((repo) => repo.repo === "northwind/docs")?.dependencies).toHaveLength(1);
    expect(scan.matches.filter((match) => match.repo === "northwind/docs")).toHaveLength(0);

    const lodash = scan.advisories.find((advisory) => advisory.id === "GHSA-demo-lod4-17xx");
    expect(lodash?.sources).toEqual(["github", "nvd", "osv", "social"]);
    expect(lodash?.cvssScore).toBe(9.8);
    expect(scan.unmatchedAdvisoryIds).toEqual(expect.arrayContaining(["GHSA-demo-reac-180x", "OSV-2026-90001"]));
    expect(scan.advisories.some((advisory) => advisory.id === "GHSA-demo-old1-000x")).toBe(false);
    expect(scan.advisories.some((advisory) => advisory.id === "GHSA-demo-with-draw")).toBe(false);
    expect(scan.advisories.some((advisory) => advisory.id === "CVE-2026-10099")).toBe(false);

    const github = scan.sources.find((source) => source.id === "github");
    expect(github).toMatchObject({ kept: 7, skippedWindow: 1, skippedWithdrawn: 1, skippedEcosystem: 1 });
    const nvd = scan.sources.find((source) => source.id === "nvd");
    expect(nvd).toMatchObject({ kept: 2, skippedEcosystem: 1 });
    expect(scan.sources.find((source) => source.id === "social")?.kept).toBe(1);

    const requests = scan.matches.find((match) => match.dependency.name === "requests");
    expect(requests?.fix.targetVersion).toBe("2.32.3");
    expect(requests?.fix.edits.map((edit) => edit.path).sort()).toEqual(["pyproject.toml", "requirements.txt"]);
    expect(requests?.fix.edits.every((edit) => edit.diff.includes("2.32.3"))).toBe(true);

    const minimist = scan.matches.find((match) => match.dependency.name === "minimist");
    expect(minimist?.fix.edits[0]?.diff).toContain("overrides");
    expect(minimist?.fix.edits[0]?.diff).toContain("1.2.8");
    expect(minimist?.dependency.direct).toBe(false);

    const net = scan.matches.find((match) => match.dependency.name === "golang.org/x/net");
    expect(net?.fix.targetVersion).toBe("v0.24.0");
    expect(net?.fix.commands[0]).toBe("go get golang.org/x/net@v0.24.0");
    expect(net?.fix.edits[0]?.diff).toContain("v0.24.0");

    const report = renderReport(scan);
    expect(report).toContain("Patch Patrol");
    expect(report).toContain("never merges");
    expect(report).toContain("lodash@4.17.20");
  });

  it("drops the idna advisory when the window is 24 hours", async () => {
    const scan = await runDemoScan({ windowHours: 24 });
    expect(scan.matches.some((match) => match.dependency.name === "idna")).toBe(false);
    expect(scan.matches.some((match) => match.dependency.name === "lodash")).toBe(true);
  });
});

describe("source helpers", () => {
  it("reads only recent supported ids from an OSV index chunk", () => {
    const csv = [
      "2026-10-23T22:00:00Z,npm/GHSA-demo-lod4-17xx",
      "2026-10-23T21:00:00Z,Maven/GHSA-demo-mvn1-000x",
      "2026-10-22T12:00:00Z,PyPI/PYSEC-DEMO-2026-1001",
      "2026-10-20T00:00:00Z,npm/GHSA-demo-old1-000x",
    ].join("\n");
    const selected = selectRecentOsvIds(csv, new Date("2026-10-21T22:00:00Z"), 10);
    expect(selected.ids).toEqual(["GHSA-demo-lod4-17xx", "PYSEC-DEMO-2026-1001"]);
    expect(selected.exhausted).toBe(true);
  });

  it("maps node and python CPEs and skips operating systems", () => {
    expect(mapCpe("cpe:2.3:a:lodash:lodash:*:*:*:*:*:node.js:*:*")).toEqual({
      ecosystem: "npm",
      name: "lodash",
    });
    expect(mapCpe("cpe:2.3:a:python-requests:requests:*:*:*:*:*:python:*:*")).toEqual({
      ecosystem: "pypi",
      name: "requests",
    });
    expect(mapCpe("cpe:2.3:a:golang:net:*:*:*:*:*:*:*:*")).toEqual({
      ecosystem: "go",
      name: "golang.org/x/net",
    });
    expect(mapCpe("cpe:2.3:o:linux:linux_kernel:*:*:*:*:*:*:*:*")).toBeNull();
    expect(mapCpe("cpe:2.3:a:apache:log4j:*:*:*:*:*:*:*:*")).toBeNull();
  });

  it("formats NVD timestamps without a trailing Z", () => {
    expect(nvdStamp(new Date("2026-10-21T22:00:00.000Z"))).toBe("2026-10-21T22:00:00.000");
  });

  it("marks a withdrawn GitHub advisory", () => {
    const advisory = normalizeGitHubAdvisory({
      ghsa_id: "GHSA-demo-with-draw",
      published_at: "2026-10-23T01:00:00Z",
      withdrawn_at: "2026-10-23T02:00:00Z",
      summary: "withdrawn",
      vulnerabilities: [{ package: { ecosystem: "npm", name: "left-pad" }, vulnerable_version_range: "< 1.0.0" }],
    });
    expect(advisory?.withdrawn).toBe(true);
  });

  it("leaves the social slot empty until a provider is registered", async () => {
    const slot = new SocialSourceSlot();
    const empty = await slot.fetch({ since: new Date(0), until: new Date() });
    expect(empty.advisories).toEqual([]);
    expect(empty.note).toContain("register");
    slot.register({
      id: "x",
      name: "X",
      async fetch() {
        return [
          {
            id: "SOCIAL-1",
            aliases: [],
            sources: ["social"],
            summary: "placeholder",
            severity: "low",
            publishedAt: "2026-10-23T00:00:00Z",
            references: [],
            affected: [],
          },
        ];
      },
    });
    const filled = await slot.fetch({ since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-31T00:00:00Z") });
    expect(filled.advisories).toHaveLength(1);
    expect(filled.advisories[0]?.sources).toEqual(["social"]);
  });
});

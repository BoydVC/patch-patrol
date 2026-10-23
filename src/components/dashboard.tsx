"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatUtc, severityLabel } from "@/lib/patrol/format";
import type { PrResult } from "@/lib/patrol/pr";
import type { Advisory, Match, ScanResult, Severity } from "@/lib/patrol/types";

const SEVERITY_CLASS: Record<Severity, string> = {
  critical: "bg-[#f3d6d2] text-[#6f221c]",
  high: "bg-[#f6e0cc] text-[#7a3e0c]",
  medium: "bg-[#f3e8c4] text-[#6d5310]",
  low: "bg-[#d7e6df] text-[#1e4a3c]",
  unknown: "bg-muted text-muted-foreground",
};

export function Dashboard({
  initial,
  draftPrsEnabled,
}: {
  initial: ScanResult;
  draftPrsEnabled: boolean;
}) {
  const [scan, setScan] = useState(initial);
  const [windowHours, setWindowHours] = useState(initial.windowHours);
  const [liveRepos, setLiveRepos] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PrResult | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const selected = scan.matches.find((match) => match.id === selectedId) ?? null;
  const advisory = selected ? scan.advisories.find((item) => item.id === selected.advisoryId) : undefined;

  const matrix = useMemo(() => buildMatrix(scan), [scan]);
  const critical = scan.matches.filter((match) => advisorySeverity(scan, match) === "critical").length;

  async function rescan(mode: "demo" | "live", hours = windowHours) {
    setLoading(true);
    setError(null);
    setPlan(null);
    const repos = liveRepos
      .split(/[\s,]+/)
      .map((repo) => repo.trim())
      .filter(Boolean);
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, windowHours: hours, repos }),
    });
    const body = (await response.json()) as ScanResult & { error?: string };
    if (!response.ok) {
      setError(body.error ?? "The scan failed.");
      setLoading(false);
      return;
    }
    setScan(body);
    setSelectedId(null);
    setLoading(false);
  }

  async function requestPlan(mode: "dry-run" | "draft") {
    if (!selected) return;
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    const payload =
      scan.mode === "live"
        ? {
            origin: "live",
            mode,
            repo: selected.repo,
            ecosystem: selected.dependency.ecosystem,
            name: selected.dependency.name,
            targetVersion: selected.fix.targetVersion,
            direct: selected.dependency.direct,
            title: selected.fix.prTitle,
            body: selected.fix.prBody,
          }
        : { origin: "demo", mode, matchId: selected.id, windowHours: scan.windowHours };
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as PrResult & { error?: string };
    if (!response.ok) {
      setPlanError(body.error ?? "Could not prepare the fix.");
      setPlanning(false);
      return;
    }
    setPlan(body);
    setPlanning(false);
  }

  function downloadReport() {
    const blob = new Blob([JSON.stringify(scan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "patch-patrol-report.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-full">
      <div className="border-b-4 border-[#8f2d2a] bg-[#f7f3ec]">
        <header className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="font-mono text-xs tracking-[0.18em] text-[#8f2d2a] uppercase">Security watch</p>
            <h1 className="font-heading text-5xl tracking-tight text-[#1c1915]">Patch Patrol</h1>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-[#3f3a33]">
              Advisories from the last {scan.windowHours} hours, matched to the manifests in your repos.
              Fix plans stay local unless you explicitly open a draft pull request.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Window
              <select
                aria-label="Advisory window"
                className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
                value={windowHours}
                onChange={(event) => {
                  const hours = Number(event.target.value);
                  setWindowHours(hours);
                  if (scan.mode === "demo") void rescan("demo", hours);
                }}
              >
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
                <option value={72}>72 hours</option>
                <option value={168}>7 days</option>
              </select>
            </label>
            <Button type="button" onClick={() => void rescan("demo")} disabled={loading}>
              Run demo
            </Button>
            <Button type="button" variant="outline" onClick={downloadReport}>
              Download JSON
            </Button>
          </div>
        </header>
      </div>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-relaxed">
            {scan.clock === "frozen"
              ? "Demo clock is frozen so the Northwind fixtures stay inside the window. Nothing was sent to GitHub."
              : "Live feeds. A source can fail on its own without dropping the others."}{" "}
            <span className="font-mono text-xs">
              {formatUtc(scan.since)} → {formatUtc(scan.until)}
            </span>
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {draftPrsEnabled ? "GITHUB_TOKEN is set. Drafts only." : "No token. Dry run only."}
          </p>
        </section>

        <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {scan.sources.map((source) => (
            <div key={source.id} className="rounded-xl border border-border bg-card px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{source.name}</p>
                <Badge variant={source.status === "error" ? "destructive" : "outline"}>{source.status}</Badge>
              </div>
              <p className="font-heading mt-2 text-3xl">{source.kept}</p>
              <p className="text-xs text-muted-foreground">kept in window</p>
              {source.error ? <p className="mt-2 text-xs text-destructive">{source.error}</p> : null}
              {source.note ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{source.note}</p> : null}
            </div>
          ))}
        </section>

        {error ? (
          <p className="rounded-lg border border-destructive/40 bg-[#f3d6d2] px-3 py-2 text-sm text-[#6f221c]">{error}</p>
        ) : null}
        {loading ? (
          <div className="grid gap-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Advisories" value={scan.advisories.length} />
          <Stat label="Repos" value={scan.repos.length} />
          <Stat label="Matches" value={scan.matches.length} />
          <Stat label="Critical" value={critical} />
        </section>

        <section className="rounded-xl border border-border bg-card">
          <div className="flex items-end justify-between gap-3 px-4 py-3">
            <div>
              <h2 className="font-heading text-2xl">Advisories × repos</h2>
              <p className="text-sm text-muted-foreground">
                A cell is the match score. Empty means that advisory does not touch the repo.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto px-2 pb-3">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <caption className="sr-only">Advisory scores by repository</caption>
              <thead>
                <tr className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
                  <th className="px-2 py-2 font-medium">Advisory</th>
                  {scan.repos.map((repo) => (
                    <th key={repo.repo} className="px-2 py-2 font-medium">
                      {repo.repo.split("/")[1] ?? repo.repo}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.map((row) => (
                  <tr key={row.advisory.id} className="border-b border-border/70">
                    <th className="px-2 py-2 text-left font-mono text-xs font-normal">{row.advisory.id}</th>
                    {row.cells.map((cell) => (
                      <td key={cell.repo} className="px-2 py-2">
                        {cell.match ? (
                          <button
                            type="button"
                            className="font-mono text-sm underline-offset-2 hover:underline"
                            onClick={() => {
                              setSelectedId(cell.match?.id ?? null);
                              setPlan(null);
                              setPlanError(null);
                            }}
                          >
                            {cell.match.score.score}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <Tabs defaultValue="plans">
          <TabsList>
            <TabsTrigger value="plans">Fix plans</TabsTrigger>
            <TabsTrigger value="advisories">Advisory feed</TabsTrigger>
            <TabsTrigger value="repos">Repositories</TabsTrigger>
          </TabsList>
          <TabsContent value="plans" className="pt-3">
            {scan.matches.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
                No dependency matched an advisory in this window.
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-2 md:hidden">
                  {scan.matches.map((match) => (
                    <li key={match.id}>
                      <MatchButton match={match} scan={scan} onOpen={() => openMatch(match.id)} />
                    </li>
                  ))}
                </ul>
                <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
                  <table className="w-full border-collapse text-left text-sm">
                    <caption className="sr-only">Matched dependencies</caption>
                    <thead className="bg-[#ebe4d8] text-xs tracking-wide text-muted-foreground uppercase">
                      <tr>
                        <th className="px-3 py-2 font-medium">Score</th>
                        <th className="px-3 py-2 font-medium">Severity</th>
                        <th className="px-3 py-2 font-medium">Package</th>
                        <th className="px-3 py-2 font-medium">Repo</th>
                        <th className="px-3 py-2 font-medium">Reach</th>
                        <th className="px-3 py-2 font-medium">Fix</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scan.matches.map((match) => {
                        const item = scan.advisories.find((advisory) => advisory.id === match.advisoryId);
                        const severity = item?.severity ?? "unknown";
                        return (
                          <tr key={match.id} className="border-t border-border">
                            <td className="px-3 py-3 font-heading text-xl">{match.score.score}</td>
                            <td className="px-3 py-3">
                              <SeverityBadge severity={severity} />
                            </td>
                            <td className="px-3 py-3 font-mono text-xs">
                              {match.dependency.name}@{match.dependency.version ?? match.dependency.requested}
                            </td>
                            <td className="px-3 py-3">{match.repo}</td>
                            <td className="px-3 py-3 capitalize">{match.score.reachability}</td>
                            <td className="px-3 py-3">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => openMatch(match.id)}
                              >
                                Open plan
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </TabsContent>
          <TabsContent value="advisories" className="flex flex-col gap-3 pt-3">
            {scan.advisories.map((item) => (
              <article key={item.id} className="rounded-xl border border-border bg-card px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={item.severity} />
                  <span className="font-mono text-xs">{item.id}</span>
                  {item.sources.map((source) => (
                    <Badge key={source} variant="outline">
                      {source}
                    </Badge>
                  ))}
                </div>
                <p className="mt-2 text-sm leading-relaxed">{item.summary}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {item.affected.map((pkg) => `${pkg.ecosystem}:${pkg.name}`).join(", ") || "no supported package"}
                </p>
              </article>
            ))}
          </TabsContent>
          <TabsContent value="repos" className="grid gap-3 pt-3 md:grid-cols-2">
            {scan.repos.map((repo) => {
              const count = scan.matches.filter((match) => match.repo === repo.repo).length;
              return (
                <article key={repo.repo} className="rounded-xl border border-border bg-card px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">{repo.repo}</h3>
                    <p className="font-mono text-xs text-muted-foreground">{count} matches</p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {repo.files.length ? repo.files.join(", ") : "No manifest"} · {repo.dependencies.length} dependencies
                  </p>
                  <ul className="mt-3 flex flex-col gap-1 font-mono text-xs">
                    {repo.dependencies.map((dependency) => (
                      <li key={`${dependency.ecosystem}:${dependency.name}:${dependency.version ?? dependency.requested}`}>
                        {dependency.name}@{dependency.version ?? dependency.requested ?? "range"}
                        {dependency.direct ? "" : " · transitive"}
                        {dependency.dev ? " · dev" : ""}
                      </li>
                    ))}
                  </ul>
                  {repo.warnings.map((warning) => (
                    <p key={warning} className="mt-2 text-xs text-muted-foreground">
                      {warning}
                    </p>
                  ))}
                </article>
              );
            })}
          </TabsContent>
        </Tabs>

        <Separator />

        <section className="rounded-xl border border-border bg-card px-4 py-4">
          <h2 className="font-heading text-2xl">Scan live feeds</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            One GitHub repo per line, as owner/name. Patch Patrol reads root manifests through the GitHub API,
            then queries the advisory feeds. Set GITHUB_TOKEN and NVD_API_KEY in the environment if you have them.
          </p>
          <textarea
            aria-label="GitHub repositories"
            className="mt-3 min-h-24 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
            placeholder={"owner/repo"}
            value={liveRepos}
            onChange={(event) => setLiveRepos(event.target.value)}
          />
          <Button className="mt-3" type="button" variant="outline" disabled={loading} onClick={() => void rescan("live")}>
            Scan live feeds
          </Button>
        </section>

        <p className="pb-8 text-sm leading-relaxed text-muted-foreground">
          Score is CVSS times ten, or a severity stand-in, multiplied by a reachability factor. Direct production
          dependencies count fully. Transitive production is 0.8. Direct development is 0.68. Transitive development
          is 0.42. Call sites are not scanned. Draft pull requests are never merged.
        </p>
      </main>

      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedId(null);
            setPlan(null);
            setPlanError(null);
          }
        }}
      >
        <SheetContent side="right" className="overflow-y-auto">
          {selected && advisory ? (
            <FixSheet
              match={selected}
              advisory={advisory}
              plan={plan}
              planError={planError}
              planning={planning}
              draftPrsEnabled={draftPrsEnabled}
              demo={scan.mode === "demo"}
              onDryRun={() => void requestPlan("dry-run")}
              onDraft={() => void requestPlan("draft")}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );

  function openMatch(id: string) {
    setSelectedId(id);
    setPlan(null);
    setPlanError(null);
  }
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="font-heading text-4xl">{value}</p>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge variant="outline" className={`border-transparent ${SEVERITY_CLASS[severity]}`}>
      {severityLabel(severity)}
    </Badge>
  );
}

function MatchButton({
  match,
  scan,
  onOpen,
}: {
  match: Match;
  scan: ScanResult;
  onOpen: () => void;
}) {
  const severity = advisorySeverity(scan, match);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-xl border border-border bg-card px-3 py-3 text-left"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-heading text-2xl">{match.score.score}</span>
        <SeverityBadge severity={severity} />
      </div>
      <p className="mt-1 font-mono text-xs">
        {match.dependency.name}@{match.dependency.version ?? match.dependency.requested}
      </p>
      <p className="text-xs text-muted-foreground">{match.repo}</p>
    </button>
  );
}

function FixSheet({
  match,
  advisory,
  plan,
  planError,
  planning,
  draftPrsEnabled,
  demo,
  onDryRun,
  onDraft,
}: {
  match: Match;
  advisory: Advisory;
  plan: PrResult | null;
  planError: string | null;
  planning: boolean;
  draftPrsEnabled: boolean;
  demo: boolean;
  onDryRun: () => void;
  onDraft: () => void;
}) {
  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-heading text-2xl">{match.fix.prTitle}</SheetTitle>
        <SheetDescription>{advisory.summary}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={advisory.severity} />
          <Badge variant="outline">{match.score.reachability}</Badge>
          <span className="font-heading text-3xl">{match.score.score}</span>
        </div>
        <p className="text-sm">{match.explanation}</p>
        <ul className="flex flex-col gap-1 text-sm leading-relaxed">
          {match.score.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p className="text-sm">{match.fix.summary}</p>
        <div>
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Commands</p>
          <ul className="mt-1 font-mono text-xs">
            {match.fix.commands.map((command) => (
              <li key={command}>{command}</li>
            ))}
          </ul>
        </div>
        {match.fix.edits.map((edit) => (
          <pre key={edit.path} className="overflow-x-auto rounded-lg bg-[#1c1915] p-3 text-xs leading-relaxed text-[#f3efe6]">
            {edit.diff || `No textual change in ${edit.path}.`}
          </pre>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onDryRun} disabled={planning}>
            Dry-run this fix
          </Button>
          <Button type="button" variant="outline" onClick={onDraft} disabled={planning}>
            Open draft PR
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Dry run is the default and sends nothing. Opening a draft requires GITHUB_TOKEN
          {draftPrsEnabled ? ", which is set." : ", which is not set."}{" "}
          {demo ? "This match is a local fixture, so a draft is refused." : "The pull request is created as a draft."}{" "}
          Patch Patrol has no merge action.
        </p>
        {planning ? <Skeleton className="h-16 w-full" /> : null}
        {planError ? <p className="text-sm text-destructive">{planError}</p> : null}
        {plan ? (
          <div className="rounded-lg border border-border bg-[#f7f3ec] px-3 py-3 text-sm">
            <p className="font-medium">{plan.message}</p>
            <p className="mt-1 font-mono text-xs">
              draft: true · merged: false · dryRun: {String(plan.dryRun)}
            </p>
            {plan.url ? (
              <a className="mt-2 inline-block underline" href={plan.url}>
                {plan.url}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

function advisorySeverity(scan: ScanResult, match: Match): Severity {
  return scan.advisories.find((advisory) => advisory.id === match.advisoryId)?.severity ?? "unknown";
}

function buildMatrix(scan: ScanResult) {
  return [...scan.advisories]
    .map((advisory) => ({
      advisory,
      max: Math.max(0, ...scan.matches.filter((match) => match.advisoryId === advisory.id).map((match) => match.score.score)),
      cells: scan.repos.map((repo) => ({
        repo: repo.repo,
        match: scan.matches.find((match) => match.advisoryId === advisory.id && match.repo === repo.repo),
      })),
    }))
    .sort((left, right) => right.max - left.max || left.advisory.id.localeCompare(right.advisory.id));
}

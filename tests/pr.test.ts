import { describe, expect, it, vi } from "vitest";
import { planDemoFix } from "../src/lib/patrol/actions";
import { assertGitHubPath, openFixPullRequest } from "../src/lib/patrol/pr";
import { runDemoScan } from "../src/lib/patrol/demo";

describe("draft pull requests", () => {
  it("refuses merge endpoints and any path outside the draft workflow", () => {
    expect(() => assertGitHubPath("PUT", "/repos/acme/app/pulls/1/merge")).toThrow(/never merges/);
    expect(() => assertGitHubPath("POST", "/repos/acme/app/merges")).toThrow(/never merges/);
    expect(() => assertGitHubPath("DELETE", "/repos/acme/app")).toThrow(/Blocked/);
    expect(() => assertGitHubPath("POST", "/repos/acme/app/pulls")).not.toThrow();
  });

  it("does not call the network for a dry run", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("dry run must not fetch");
    });
    const result = await openFixPullRequest(
      {
        mode: "dry-run",
        owner: "northwind",
        repo: "storefront",
        title: "fix(deps): bump lodash to 4.17.21",
        body: "Patch Patrol does not merge pull requests.",
        branchName: "patch-patrol/lodash-4.17.21",
        commitMessage: "fix(deps): bump lodash to 4.17.21",
        changes: [
          {
            path: "package.json",
            before: '{ "dependencies": { "lodash": "^4.17.20" } }\n',
            after: '{ "dependencies": { "lodash": "^4.17.21" } }\n',
            diff: "--- a/package.json\n+++ b/package.json\n",
          },
        ],
      },
      { token: "should-not-be-sent", fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.draft).toBe(true);
    expect(result.opened).toBe(false);
    expect(result.message).toContain("never merges");
    expect(JSON.stringify(result)).not.toContain("should-not-be-sent");
  });

  it("opens a draft and never posts a merge when a token is present", async () => {
    const calls: Array<{ url: string; method: string; body?: { draft?: boolean } }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as { draft?: boolean }) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/merge")) throw new Error("merge was called");
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (method === "GET" && url.endsWith("/repos/northwind/storefront")) {
        return json({ default_branch: "main" });
      }
      if (url.includes("/git/ref/heads/main")) return json({ object: { sha: "abc123" } });
      if (method === "POST" && url.endsWith("/git/refs")) return json({ ref: "refs/heads/patch-patrol/lodash-4.17.21" });
      if (method === "GET" && url.includes("/contents/")) return json({ sha: "filesha", content: "" });
      if (method === "PUT" && url.includes("/contents/")) return json({ commit: { sha: "new" } });
      if (method === "POST" && url.endsWith("/pulls")) {
        expect(body?.draft).toBe(true);
        return json({ html_url: "https://github.com/northwind/storefront/pull/7", draft: true });
      }
      return json({ message: "unexpected" }, 404);
    };

    const result = await openFixPullRequest(
      {
        mode: "draft",
        owner: "northwind",
        repo: "storefront",
        title: "fix(deps): bump lodash to 4.17.21",
        body: "Draft only.",
        branchName: "patch-patrol/lodash-4.17.21",
        commitMessage: "fix(deps): bump lodash to 4.17.21",
        changes: [
          {
            path: "package.json",
            before: "{\"dependencies\":{\"lodash\":\"^4.17.20\"}}\n",
            after: "{\"dependencies\":{\"lodash\":\"^4.17.21\"}}\n",
            diff: "diff",
          },
        ],
      },
      { token: "ghp_test", fetchImpl },
    );

    expect(result.opened).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.url).toBe("https://github.com/northwind/storefront/pull/7");
    const pull = calls.find((call) => call.url.endsWith("/pulls"));
    expect(pull?.method).toBe("POST");
    expect(pull?.body?.draft).toBe(true);
    expect(calls.some((call) => call.url.includes("/merge"))).toBe(false);
    expect(calls.some((call) => JSON.stringify(call.body ?? {}).includes("ghp_test"))).toBe(false);
  });

  it("refuses a placeholder token from .env.example", async () => {
    await expect(
      openFixPullRequest(
        {
          mode: "draft",
          owner: "northwind",
          repo: "storefront",
          title: "t",
          body: "b",
          branchName: "patch-patrol/lodash-4.17.21",
          commitMessage: "t",
          changes: [{ path: "package.json", before: "a", after: "b", diff: "d" }],
        },
        { token: "replace-with-a-github-token" },
      ),
    ).rejects.toThrow(/placeholder/);
  });

  it("refuses to open a draft without a token", async () => {
    await expect(
      openFixPullRequest(
        {
          mode: "draft",
          owner: "northwind",
          repo: "storefront",
          title: "t",
          body: "b",
          branchName: "patch-patrol/lodash-4.17.21",
          commitMessage: "t",
          changes: [{ path: "package.json", before: "a", after: "b", diff: "d" }],
        },
        {},
      ),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it("keeps the demo plan local even if draft mode is requested", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("demo draft must not fetch");
    });
    const scan = await runDemoScan();
    const match = scan.matches.find((item) => item.dependency.name === "lodash");
    const plan = await planDemoFix({
      matchId: match!.id,
      mode: "draft",
      fetchImpl,
      token: "ghp_test",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(plan.opened).toBe(false);
    expect(plan.dryRun).toBe(true);
    expect(plan.message).toContain("local fixtures");
    expect(plan.changes[0]?.diff).toContain("4.17.21");
  });
});

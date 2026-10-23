# Patch Patrol

Patch Patrol watches personal repositories for newly published dependency advisories. It reads public feeds, parses dependency manifests, scores each match, and writes a fix plan. It runs locally. Do not deploy it publicly.

Dry-run is the default. Pull requests are draft-only, and only when you ask. Patch Patrol never merges.

## Install

Requires Node.js 20 or newer.

```bash
npm install
```

You do not need an account, a token, or a `.env` file to install or to run the fixture demo.

## Fixture demo (no GitHub token)

```bash
npm test
npm run demo
```

`npm run demo` reads the Northwind fixtures under `fixtures/`. The clock is frozen at 23 Oct 2026, 22:00 UTC, so the sample advisories stay inside the default 48-hour window. Nothing is sent to GitHub.

The report ends with a dry-run result for the highest-scoring match (`lodash` in the fixtures):

```text
Dry-run result
  source: fixtures
  githubToken: not used
  mode: dry-run
  dryRun: true
  draft: true
  merged: false
  opened: false
  githubRequestsSent: 0
  Dry run. No GitHub request was sent. Patch Patrol never merges.
```

Dry-run another package with `npm run demo -- --package requests`. `patch-patrol.config.json` points at the same fixture checkouts if you pass `--config patch-patrol.config.json`.

## Dashboard

```bash
npm run dev
```

Serves the same fixture scan at [http://127.0.0.1:4179](http://127.0.0.1:4179). Open a row and choose **Dry-run this fix**. The result says `merged: false`.

`npm run build` then `npm start` serves a production build on the same port, still local. Do not put that process on the public internet.

## GitHub configuration

Secrets are environment variables. The names and placeholders live only in [`.env.example`](.env.example).

```bash
cp .env.example .env
```

`.env` is gitignored. Replace `replace-with-a-github-token` and `replace-with-an-nvd-api-key` there. Placeholders are treated as unset, so a copied example cannot authorize a draft or ride along on a request.

| Variable | Required | Effect |
| --- | --- | --- |
| `GITHUB_TOKEN` | Only for `--draft` on a live repo | Raises the GitHub rate limit. Authorizes opening one draft pull request. |
| `NVD_API_KEY` | No | Raises the NVD rate limit. |

`npm run dev` loads `.env` through Next.js. The CLI loads `.env` itself and does not override variables already set in the shell. The fixture demo ignores both.

Live scan, still dry-run, still no merge:

```bash
npm run patrol -- --live --repo owner/name --window 48
```

Open one draft, and only one, after the token in `.env` is real:

```bash
npm run patrol -- --live --repo owner/name --draft --package lodash
```

`--draft` without `--package` or `--match` is refused. The client allowlists read-repo, create-ref, get-file, put-file, and create-pull. The pull payload always sets `draft: true`. A URL containing `/merge` throws.

## What a scan does

1. **Fetch advisories** published or modified inside the window (48 hours unless you change it).
   - [GitHub Advisory Database](https://docs.github.com/en/rest/security-advisories/global-advisories) for npm, pip, Go, and Rust.
   - [OSV](https://osv.dev): a range-read of the public modified index for npm, PyPI, Go, and crates.io, plus a batch query for the packages you actually depend on.
   - [NVD CVE API 2.0](https://nvd.nist.gov/developers/vulnerabilities). CPE rows are kept only when the target software is Node, Python, or Rust, or when the product is in a small Go alias list.
   - **Social slot.** Empty until you register a provider. The demo registers a fixture feed so the slot can participate in a match.
2. **Read manifests** for a configurable repo list: `package.json` plus npm lockfiles, `requirements.txt`, `pyproject.toml`, `go.mod`, and `Cargo.toml` / `Cargo.lock`.
3. **Match** resolved versions, or an unresolved range when there is no lock, against advisory ranges.
4. **Score** each match. CVSS × 10 when a score exists, otherwise a severity stand-in (critical 96, high 78, medium 52, low 28). Multiply by a reachability hint: direct production 1, transitive production 0.8, direct development 0.68, transitive development 0.42.
5. **Write a fix plan**: target version, manifest diff, and the command to refresh a lockfile.

Live scans read root manifests only. Workspace packages nested in a monorepo are not walked. Lockfiles are not rewritten in the pull request. The plan names `npm install`, `pip install`, `go get`, or `cargo update`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm test` | Vitest. Version ranges, manifests, the frozen demo scan, and the draft client. |
| `npm run demo` | Fixture scan plus a dry-run. No token. |
| `npm run patrol` | Same CLI. Add `--live` for real repos. |
| `npm run dev` | Local dashboard on port 4179. |
| `npm start` | Local production server on port 4179, after `npm run build`. |

## Social / X slot

`SocialSourceSlot` accepts any `AdvisorySource`. Patch Patrol does not ship a live X client. Register one beside the process that runs a scan:

```ts
import { SocialSourceSlot, type AdvisorySource } from "./src/lib/patrol/sources/social";

const xFeed: AdvisorySource = {
  id: "x",
  name: "X",
  async fetch({ since, until }) {
    // Map posts from your X client into Advisory records.
    return [];
  },
};

const slot = new SocialSourceSlot();
slot.register(xFeed);
```

Pass that slot to `runLiveScan({ social: slot, repos, windowHours })`. Providers are trusted local code. Remote post text is data, not instructions.

## Limits

See [NOTES.md](NOTES.md). Reachability is a hint from the manifest, not a proof that a vulnerable function runs. NVD package names are incomplete on purpose. OSV's full modified index is about 150MB and sorted newest-first; the client reads a short prefix and stops, then queries your packages.

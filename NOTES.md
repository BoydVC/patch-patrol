# Patch Patrol notes

v1 is the first private-repo slice. `package.json` is version 0.1.0. This file is the capability list for that slice.

## v1 capabilities

- Fixture demo with a frozen clock (23 Oct 2026, 22:00 UTC) and five local Northwind repos. No GitHub token and no network.
- Advisory intake for GitHub Advisory Database, OSV, and NVD CVE API 2.0, default window 48 hours. Withdrawn rows and rows outside the window are dropped. Shared GHSA, CVE, and PYSEC ids are merged.
- Pluggable social slot (`SocialSourceSlot`). No live X client is included. The demo registers a fixture provider.
- Manifest parsers for `package.json` and npm lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), `requirements.txt`, `pyproject.toml`, `go.mod`, and `Cargo.toml` / `Cargo.lock`.
- Version matching for npm and Cargo semver, PEP 440, and Go versions.
- Score from CVSS, or a severity stand-in, times a reachability hint (direct vs transitive, production vs development).
- Fix plan per match: target version, manifest diff, and the lockfile command.
- Draft-only GitHub client. Dry-run is the default and sends nothing. A draft open always posts `draft: true`. Paths containing `/merge` throw. There is no merge method.
- Local dashboard and a text report of advisories against repos.

## Known limits

- The fixture demo is the supported offline path. It never opens a pull request, even if `--draft` is passed.
- Live scans read root manifests only. Nested workspace packages are not walked.
- Reachability is a hint from the manifest, not a call-site scan.
- Lockfiles are not rewritten inside a pull request. The plan names `npm install`, `pip install`, `go get`, or `cargo update`.
- NVD package names are filtered to Node, Python, Rust, and a short Go alias list. Other CPEs are counted and skipped.
- OSV's modified index is sampled from a short newest-first prefix, then queried per package.
- One `--draft` run opens a pull request for a single `--package` or `--match`, not every match.
- Tokens belong in `.env` (see `.env.example`). Placeholders are treated as unset. Do not deploy this app publicly.

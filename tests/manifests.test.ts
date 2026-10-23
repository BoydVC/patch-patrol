import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGoMod, parseManifestSet, parsePnpmLock, parseYarnLock } from "../src/lib/patrol/manifests";
import { loadLocalRepo } from "../src/lib/patrol/repos";

const root = path.resolve(__dirname, "..");

describe("manifest parsers", () => {
  it("reads the storefront lock and keeps direct, dev, and transitive packages apart", () => {
    const repo = loadLocalRepo("northwind/storefront", path.join(root, "fixtures/repos/northwind-storefront"));
    const byName = Object.fromEntries(repo.dependencies.map((dependency) => [dependency.name, dependency]));
    expect(byName.lodash).toMatchObject({ version: "4.17.20", direct: true, dev: false, requested: "^4.17.20" });
    expect(byName.express).toMatchObject({ version: "4.18.2", direct: true, dev: false });
    expect(byName.react).toMatchObject({ version: "18.3.1", direct: true, dev: false });
    expect(byName.vitest).toMatchObject({ version: "1.6.0", direct: true, dev: true });
    expect(byName.minimist).toMatchObject({ version: "1.2.5", direct: false, dev: false });
    expect(byName.lodash.manifestPath).toBe("package.json");
  });

  it("dedupes requirements.txt and pyproject.toml, and marks the dev extra", () => {
    const repo = loadLocalRepo("northwind/catalog", path.join(root, "fixtures/repos/northwind-catalog"));
    const names = repo.dependencies.map((dependency) => dependency.name).sort();
    expect(names).toEqual(["flask", "pytest", "requests", "urllib3"]);
    const requests = repo.dependencies.find((dependency) => dependency.name === "requests");
    expect(requests).toMatchObject({ version: "2.31.0", direct: true, dev: false, ecosystem: "pypi" });
    expect(repo.dependencies.find((dependency) => dependency.name === "pytest")?.dev).toBe(true);
  });

  it("parses go.mod, including indirect requires", () => {
    const rows = parseGoMod(`module example.com/app

go 1.22

require golang.org/x/net v0.23.0

require (
\tgithub.com/google/uuid v1.6.0
\tgithub.com/davecgh/go-spew v1.1.1 // indirect
)
`);
    expect(rows).toEqual([
      expect.objectContaining({ name: "golang.org/x/net", version: "v0.23.0", direct: true }),
      expect.objectContaining({ name: "github.com/google/uuid", version: "v1.6.0", direct: true }),
      expect.objectContaining({ name: "github.com/davecgh/go-spew", version: "v1.1.1", direct: false }),
    ]);
  });

  it("joins Cargo.toml with Cargo.lock and drops the root package", () => {
    const repo = loadLocalRepo("northwind/edge", path.join(root, "fixtures/repos/northwind-edge"));
    const byName = Object.fromEntries(repo.dependencies.map((dependency) => [dependency.name, dependency]));
    expect(byName.edge).toBeUndefined();
    expect(byName.idna).toMatchObject({ version: "0.5.0", direct: true, dev: false });
    expect(byName.serde).toMatchObject({ version: "1.0.203", direct: true, dev: false });
    expect(byName.tempfile).toMatchObject({ version: "3.10.1", direct: true, dev: true });
    expect(byName["unicode-bidi"]).toMatchObject({ version: "0.3.15", direct: false, dev: false });
  });

  it("parses classic yarn.lock and pnpm lockfiles", () => {
    const yarn = parseYarnLock(fs.readFileSync(path.join(root, "fixtures/manifests/yarn.lock"), "utf8"));
    expect(yarn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "lodash", version: "4.17.20" }),
        expect.objectContaining({ name: "@scope/pkg", version: "1.2.3" }),
      ]),
    );
    const warnings: string[] = [];
    const pnpm = parseManifestSet(
      {
        "package.json": JSON.stringify({
          dependencies: { lodash: "^4.17.20" },
          devDependencies: { vitest: "^1.6.0" },
        }),
        "pnpm-lock.yaml": fs.readFileSync(path.join(root, "fixtures/manifests/pnpm-lock.yaml"), "utf8"),
      },
      warnings,
    );
    const byName = Object.fromEntries(pnpm.map((dependency) => [dependency.name, dependency]));
    expect(byName.lodash).toMatchObject({ version: "4.17.20", direct: true, dev: false });
    expect(byName.vitest).toMatchObject({ version: "1.6.0", direct: true, dev: true });
    expect(byName.minimist).toMatchObject({ version: "1.2.5", direct: false });
    expect(parsePnpmLock(fs.readFileSync(path.join(root, "fixtures/manifests/pnpm-lock.yaml"), "utf8")).length).toBeGreaterThan(0);
  });
});

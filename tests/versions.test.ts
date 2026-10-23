import { describe, expect, it } from "vitest";
import {
  compareVersions,
  namesEqual,
  parseAdvisoryRange,
  requestedOverlaps,
  versionInRange,
  versionMatchesAffected,
} from "../src/lib/patrol/versions";

describe("version ranges", () => {
  it("compares semver, including prereleases and a leading v", () => {
    expect(compareVersions("npm", "4.17.20", "4.17.21")).toBeLessThan(0);
    expect(compareVersions("npm", "4.17.21", "4.17.21")).toBe(0);
    expect(compareVersions("npm", "1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("go", "v0.23.0", "0.24.0")).toBeLessThan(0);
    expect(compareVersions("crates", "0.5.0", "0.5.1")).toBeLessThan(0);
  });

  it("compares Python versions with the common PEP 440 order", () => {
    expect(compareVersions("pypi", "2.31.0", "2.32.3")).toBeLessThan(0);
    expect(compareVersions("pypi", "2.32.3", "2.32.3")).toBe(0);
    expect(compareVersions("pypi", "1.0.0a1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("pypi", "1.0.0", "1.0.0.post1")).toBeLessThan(0);
    expect(compareVersions("pypi", "1.0.0.dev1", "1.0.0a1")).toBeLessThan(0);
  });

  it("treats names as case-insensitive for npm and PyPI, and exact for Go", () => {
    expect(namesEqual("npm", "Lodash", "lodash")).toBe(true);
    expect(namesEqual("pypi", "Requests", "requests")).toBe(true);
    expect(namesEqual("pypi", "Foo_Bar", "foo-bar")).toBe(true);
    expect(namesEqual("go", "golang.org/x/net", "golang.org/x/net")).toBe(true);
    expect(namesEqual("go", "Golang.org/x/net", "golang.org/x/net")).toBe(false);
  });

  it("parses GitHub ranges and tests membership", () => {
    const [range] = parseAdvisoryRange(">= 1.0.0, < 1.2.3");
    expect(versionInRange("npm", "1.2.2", range)).toBe(true);
    expect(versionInRange("npm", "1.2.3", range)).toBe(false);
    expect(versionInRange("npm", "0.9.0", range)).toBe(false);
    const [upper] = parseAdvisoryRange("< 4.17.21");
    expect(versionInRange("npm", "4.17.20", upper)).toBe(true);
    expect(versionInRange("npm", "4.17.21", upper)).toBe(false);
    const [exclusive] = parseAdvisoryRange("> 1.0.0, <= 1.2.0");
    expect(versionInRange("npm", "1.0.0", exclusive)).toBe(false);
    expect(versionInRange("npm", "1.2.0", exclusive)).toBe(true);
  });

  it("matches explicit versions and refuses an unparsed version", () => {
    const hit = versionMatchesAffected("npm", "1.2.5", [], ["1.2.5"]);
    expect(hit.match).toBe(true);
    expect(versionMatchesAffected("npm", "not-a-version", [{ fixed: "1.0.0" }], undefined).uncertain).toBe(true);
  });

  it("detects overlap between a requested range and a vulnerable range", () => {
    expect(requestedOverlaps("npm", "^4.17.20", [{ fixed: "4.17.21" }])).toBe(true);
    expect(requestedOverlaps("npm", "^18.3.1", [{ fixed: "18.2.0" }])).toBe(false);
    expect(requestedOverlaps("pypi", "==2.31.0", [{ fixed: "2.32.3" }])).toBe(true);
    expect(requestedOverlaps("pypi", ">=2.32.3", [{ fixed: "2.32.3" }])).toBe(false);
  });
});

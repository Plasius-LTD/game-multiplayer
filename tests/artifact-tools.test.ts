import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const spawn = childProcess.spawnSync;
const processCall = vi.spyOn(childProcess, "spawnSync");
const require = createRequire(import.meta.url);
const privateTool = require("../scripts/verify-private-artifacts.cjs");
const publicTool = require("../scripts/verify-public-artifacts.cjs");
let root: string;
let inventory: unknown;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "multiplayer-policy-"));
  spawn("git", ["init", "--quiet", root]);
  fs.writeFileSync(path.join(root, "package.json"), '{"files":["dist"]}');
  inventory = [{ files: [{ path: "package.json" }, { path: "dist/index.js" }] }];
  processCall.mockImplementation(((command: string, args: string[], options: any) => command === "npm"
    ? { status: 0, stdout: JSON.stringify(inventory), stderr: "" } : spawn(command, args, options)) as any);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("source and artifact policy entry points", () => {
  it("checks only metadata and reports rule counts for private artifacts", () => {
    expect(privateTool.main([])).toBe(0);
    fs.mkdirSync(path.join(root, "legal"));
    fs.writeFileSync(path.join(root, "legal", "cla-registry.json"), "SYNTHETIC_CONTENT_MUST_NOT_BE_READ");
    fs.writeFileSync(path.join(root, "legal", "another.csv"), "SYNTHETIC_CONTENT_MUST_NOT_BE_READ");
    expect(privateTool.main([root])).toBe(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SYNTHETIC_CONTENT");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("cla-registry.json");
    expect(privateTool.main(["one", "two"])).toBe(2);
  });

  it("checks source before npm and rejects tracked or filesystem copies of prohibited metadata", () => {
    publicTool.main(["--source-only"]); publicTool.main([]); publicTool.main(["--package-dir", "."]);
    expect(publicTool.normalizeArtifactPath(".\\package\\legal\\ＣＬＡ－ＲＥＧＩＳＴＲＹ．ｃｓｖ")).toBe("legal/cla-registry.csv");
    fs.mkdirSync(path.join(root, "legal"));
    fs.writeFileSync(path.join(root, "legal", "CLA-REGISTRY.csv"), "SYNTHETIC_CONTENT_MUST_NOT_BE_READ");
    spawn("git", ["-C", root, "add", "legal/CLA-REGISTRY.csv"]);
    expect(() => publicTool.main([])).toThrow("Source contains prohibited path metadata (1)");
    fs.unlinkSync(path.join(root, "legal", "CLA-REGISTRY.csv"));
    expect(() => publicTool.main([])).toThrow("Source contains prohibited path metadata (1)");
  });

  it("rejects malformed inventories and does not print private process diagnostics", () => {
    for (const value of [null, [], [null], [{ files: null }], [{ files: [{ path: "package/legal/CLA-REGISTRY.csv" }] }]]) {
      inventory = value; expect(() => publicTool.main([])).toThrow();
    }
    processCall.mockImplementation(((command: string, args: string[], options: any) => command === "npm"
      ? { status: 0, stdout: "not-json", stderr: "" } : spawn(command, args, options)) as any);
    expect(() => publicTool.main([])).toThrow("valid JSON");
    processCall.mockReturnValue({ status: 1, stderr: "SYNTHETIC_PRIVATE_DETAIL", stdout: "" } as any);
    expect(() => publicTool.main([])).toThrow("Artifact command failed; details were not logged");
  });

  it("rejects path escape, symlinks and invalid arguments without disclosing their values", () => {
    for (const args of [["SYNTHETIC_PRIVATE_DETAIL"], ["--package-dir"], ["--package-dir", "--source-only"],
      ["--source-only", "--package-dir", "."], ["--package-dir", "../SYNTHETIC_PRIVATE_DETAIL"], ["--package-dir", root]]) {
      try { publicTool.main(args); throw new Error("should-reject"); }
      catch (error) { expect((error as Error).message).not.toBe("should-reject"); expect((error as Error).message).not.toContain("SYNTHETIC_PRIVATE_DETAIL"); }
    }
    fs.symlinkSync(os.tmpdir(), path.join(root, "legal")); expect(() => publicTool.main([])).toThrow("symlink");
    fs.unlinkSync(path.join(root, "legal")); fs.writeFileSync(path.join(root, "legal"), "");
    expect(() => publicTool.main([])).toThrow("not a directory");
    fs.unlinkSync(path.join(root, "legal")); fs.unlinkSync(path.join(root, "package.json"));
    fs.symlinkSync(path.join(root, "target.json"), path.join(root, "package.json"));
    expect(() => publicTool.main([])).toThrow("manifest is not a regular file");
  });
});

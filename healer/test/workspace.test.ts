import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath, workspaceFile, workspaceTree } from "../src/api/workspace.js";

const ROOT = path.resolve("/repo");

describe("resolveWorkspacePath", () => {
  it("allows TypeScript files under the allowlisted roots", () => {
    expect(resolveWorkspacePath("services/src/service.ts", ROOT)).toBe(path.join(ROOT, "services/src/service.ts"));
    expect(resolveWorkspacePath("healer/src/fix/catalog.ts", ROOT)).toBe(path.join(ROOT, "healer/src/fix/catalog.ts"));
  });

  it("rejects paths that escape the allowlist", () => {
    expect(resolveWorkspacePath("../.env", ROOT)).toBeNull();
    expect(resolveWorkspacePath(".env", ROOT)).toBeNull();
    expect(resolveWorkspacePath("services/src/../../.env", ROOT)).toBeNull();
    expect(resolveWorkspacePath("services/src-evil/x.ts", ROOT)).toBeNull();
    expect(resolveWorkspacePath(path.join(ROOT, "package.json"), ROOT)).toBeNull();
  });

  it("rejects non-TypeScript files even inside the roots", () => {
    expect(resolveWorkspacePath("services/src/secrets.json", ROOT)).toBeNull();
    expect(resolveWorkspacePath("services/src/service.ts\0.ts", ROOT)).toBeNull();
  });
});

describe("workspace on the real repo", () => {
  it("lists source files and reads one", async () => {
    const tree = await workspaceTree();
    expect(tree.some((file) => file.path === "services/src/service.ts")).toBe(true);
    expect(tree.every((file) => file.path.endsWith(".ts"))).toBe(true);
    expect(await workspaceFile("services/src/service.ts")).toContain("/health");
    expect(await workspaceFile("../package.json")).toBeNull();
  });
});

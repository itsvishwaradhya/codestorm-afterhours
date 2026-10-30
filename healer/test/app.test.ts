import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppPath } from "../src/app/files.js";
import { scriptedBug } from "../src/app/inject.js";
import { discoverRoutes, summarize } from "../src/app/proxy.js";
import { isServerCommand } from "../src/app/terminal.js";

const ROOT = path.resolve("/workspaces/app");

describe("resolveAppPath", () => {
  it("keeps uploads inside the app folder", () => {
    expect(resolveAppPath("server.js", ROOT)).toBe(path.join(ROOT, "server.js"));
    expect(resolveAppPath("src/routes/users.js", ROOT)).toBe(path.join(ROOT, "src/routes/users.js"));
    expect(resolveAppPath("../evil.js", ROOT)).toBeNull();
    expect(resolveAppPath("src/../../evil.js", ROOT)).toBeNull();
    expect(resolveAppPath("node_modules/express/index.js", ROOT)).toBeNull();
    expect(resolveAppPath(".git/config", ROOT)).toBeNull();
    expect(resolveAppPath("", ROOT)).toBeNull();
  });
});

describe("scriptedBug", () => {
  it("throws at the top of the first GET handler", () => {
    const source = 'app.get("/items", (req, res) => {\n  res.json([]);\n});\n';
    const bug = scriptedBug(source);
    expect(bug?.description).toContain("/items");
    expect(bug?.content).toContain('throw new Error("lookup failed")');
    expect(bug?.content.indexOf("throw")).toBeLessThan(bug!.content.indexOf("res.json"));
  });

  it("handles function handlers and routers", () => {
    expect(scriptedBug("router.get('/a', async function (req, res) { res.end(); });")).not.toBeNull();
    expect(scriptedBug("const x = 1;")).toBeNull();
  });
});

describe("app helpers", () => {
  it("discovers static GET routes and falls back to /", () => {
    expect(discoverRoutes(['app.get("/products", h); router.get(\'/cart\', h); app.get("/users/:id", h);'])).toEqual([
      "/products",
      "/cart",
    ]);
    expect(discoverRoutes(["app.post('/x', h)"])).toEqual(["/"]);
  });

  it("summarizes errors and reachability", () => {
    const stats = summarize([
      { at: 0, status: 200, ms: 10 },
      { at: 0, status: 500, ms: 20 },
      { at: 0, status: 502, ms: 5 },
      { at: 0, status: 200, ms: 30 },
    ]);
    expect(stats.errorRate).toBe(0.5);
    expect(stats.reachable).toBe(true);
    expect(summarize([{ at: 0, status: 502, ms: 1 }]).reachable).toBe(false);
  });

  it("recognises server start commands", () => {
    expect(isServerCommand("npm start")).toBe(true);
    expect(isServerCommand("npm run dev")).toBe(true);
    expect(isServerCommand("node server.js")).toBe(true);
    expect(isServerCommand("npm install")).toBe(false);
    expect(isServerCommand("ls")).toBe(false);
  });
});

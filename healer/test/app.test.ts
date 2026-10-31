import path from "node:path";
import { describe, expect, it } from "vitest";
import { GOOD_ROOT, resolveAppPath, zipEntries } from "../src/app/files.js";
import { BUG_KINDS, scriptedBug, targetsIn } from "../src/app/inject.js";
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
  const source = 'app.get("/items", (req, res) => {\n  res.json([]);\n});\napp.get("/users", (req, res) => {\n  res.json([]);\n});\n';

  it("puts the default bug at the top of the first GET handler", () => {
    const bug = scriptedBug(source);
    expect(bug?.description).toContain("/items");
    expect(bug?.content).toContain("owner.length");
    expect(bug?.content.indexOf("owner.length")).toBeLessThan(bug!.content.indexOf("res.json"));
  });

  it("targets the chosen route with the chosen kind", () => {
    const bug = scriptedBug(source, "/users", "error_response");
    expect(bug?.description).toContain("GET /users");
    const users = bug!.content.indexOf('"/users"');
    expect(bug!.content.indexOf("status(500)")).toBeGreaterThan(users);
    expect(bug!.content.slice(0, users)).not.toContain("status(500)");
    expect(scriptedBug(source, "/missing")).toBeNull();
  });

  it("produces valid JavaScript for every kind", () => {
    for (const kind of BUG_KINDS) {
      const bug = scriptedBug(source, "/items", kind);
      expect(() => new Function("app", "process", bug!.content)).not.toThrow();
    }
  });

  it("handles function handlers and routers", () => {
    expect(scriptedBug("router.get('/a', async function (req, res) { res.end(); });")).not.toBeNull();
    expect(scriptedBug("const x = 1;")).toBeNull();
  });
});

describe("targetsIn", () => {
  it("lists static GET routes and skips parameterised ones", () => {
    const source = 'app.get("/a", (q, r) => { r.end(); });\nrouter.get("/b/:id", (q, r) => { r.end(); });\napp.post("/c", (q, r) => { r.end(); });';
    expect(targetsIn("server.js", source)).toEqual([{ file: "server.js", route: "/a" }]);
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

describe("zipEntries", () => {
  it("writes one local header per file and a matching central directory", () => {
    const zip = zipEntries([
      { path: "server.js", data: Buffer.from("console.log(1)") },
      { path: "src/app.js", data: Buffer.from("") },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    const directoryAt = zip.readUInt32LE(end + 16);
    expect(zip.readUInt32LE(directoryAt)).toBe(0x02014b50);
    expect(zip.includes(Buffer.from("src/app.js"))).toBe(true);
  });
});

describe("good copy paths", () => {
  it("stay inside the last known good folder", () => {
    expect(resolveAppPath("server.js", GOOD_ROOT)).toBe(path.join(GOOD_ROOT, "server.js"));
    expect(resolveAppPath("../app/server.js", GOOD_ROOT)).toBeNull();
  });
});

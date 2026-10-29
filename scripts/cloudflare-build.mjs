import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const templates = {};
async function collect(dir) {
  for (const entry of await fs.readdir(path.join(root, "kit", dir), { withFileTypes: true })) {
    const name = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await collect(name);
    else templates[name] = await fs.readFile(path.join(root, "kit", name), "utf8");
  }
}
await collect("");
await fs.mkdir(path.join(root, ".cloudflare"), { recursive: true });
await fs.writeFile(path.join(root, ".cloudflare", "templates.js"), `// Generated from kit/; no private data.\nexport default ${JSON.stringify(templates)};\n`);
let commit = null, dirty = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  dirty = !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
} catch { /* Source archives can build, but cannot claim a verified commit. */ }
const assets = {};
for (const file of ["index.html", "shim.js", "focus.js", "focus.css", "task-edits.js"]) {
  assets[file] = createHash("sha256").update(await fs.readFile(path.join(root, "public", file))).digest("hex");
}
await fs.writeFile(path.join(root, ".cloudflare", "release.js"), `// Generated release identity; no credentials.\nexport default ${JSON.stringify({ commit, dirty, builtAt: new Date().toISOString(), assets })};\n`);
console.log(`Bundled ${Object.keys(templates).length} kit templates.`);

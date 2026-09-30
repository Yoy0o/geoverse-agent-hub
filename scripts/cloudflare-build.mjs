import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
console.log(`Bundled ${Object.keys(templates).length} kit templates.`);

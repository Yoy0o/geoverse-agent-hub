import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function template(name) {
  return fs.readFileSync(fileURLToPath(new URL("../kit/" + name, import.meta.url)), "utf8");
}

import templates from "../../.cloudflare/templates.js";

export function template(name) {
  if (!(name in templates)) throw new Error("Unknown kit template");
  return templates[name];
}

import { AsyncLocalStorage } from "node:async_hooks";

// Request scope preserves the owning Durable Object through Express/SDK callbacks.
export const runtime = new AsyncLocalStorage();
export function current() {
  const value = runtime.getStore();
  if (!value) throw new Error("Hub runtime is unavailable outside a Durable Object request");
  return value;
}

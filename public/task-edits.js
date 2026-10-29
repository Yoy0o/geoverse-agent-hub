// Keep edits outside replaceable DOM nodes. Only a confirmed write clears a draft.
(function () {
  "use strict";
  window.createTaskEdits = function ({ save, changed = () => {}, delay = 450 }) {
    const drafts = new Map(), timers = new Map(), running = new Map();
    let saved = false;
    function schedule(id) {
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => { timers.delete(id); flush(id); }, delay));
    }
    function change(id, field, value) {
      if (!drafts.has(id)) drafts.set(id, new Map());
      const fields = drafts.get(id), previous = fields.get(field);
      if (previous && Object.is(previous.value, value) && previous.state !== "error") return;
      fields.set(field, { value, state: "dirty", error: "" });
      changed(); schedule(id);
    }
    function flush(id) {
      clearTimeout(timers.get(id)); timers.delete(id);
      if (running.has(id)) return running.get(id);
      const fields = drafts.get(id);
      if (!fields || !fields.size) return Promise.resolve(true);
      const batch = [...fields.entries()], patch = Object.fromEntries(batch.map(([key, entry]) => [key, entry.value]));
      batch.forEach(([, entry]) => { entry.state = "saving"; entry.error = ""; });
      const work = Promise.resolve().then(() => save(id, patch)).then(() => {
        saved = true;
        batch.forEach(([key, entry]) => { if (fields.get(key) === entry) fields.delete(key); });
        if (!fields.size) drafts.delete(id);
        return true;
      }, (error) => {
        batch.forEach(([key, entry]) => {
          if (fields.get(key) === entry) { entry.state = "error"; entry.error = error.message || "保存失败"; }
        });
        return false;
      }).finally(() => {
        running.delete(id);
        // A newer edit made during the request must still be written. Failed drafts
        // stay available for an explicit retry, without a background retry loop.
        if ([...(drafts.get(id)?.values() || [])].some(entry => entry.state === "dirty")) schedule(id);
        changed();
      });
      running.set(id, work); changed(); return work;
    }
    function status() {
      const entries = [...drafts.values()].flatMap(fields => [...fields.values()]);
      return { count: entries.length, saving: running.size > 0,
        error: entries.find(entry => entry.state === "error")?.error || "", saved };
    }
    return { change, flush, status,
      value(id, field, fallback) { return drafts.get(id)?.has(field) ? drafts.get(id).get(field).value : fallback; },
      retry() { return Promise.all([...drafts.keys()].map(flush)); },
    };
  };
})();

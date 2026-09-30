// Adapter for the synchronous SQL interface used by the shared store.
export function sqliteAdapter(storage) {
  const sql = storage.sql;
  return {
    exec: (query) => sql.exec(query),
    transactionSync: (fn) => storage.transactionSync(fn),
    prepare(query) {
      return {
        get: (...params) => sql.exec(query, ...params).toArray()[0],
        all: (...params) => sql.exec(query, ...params).toArray(),
        run(...params) {
          sql.exec(query, ...params).toArray();
          const info = sql.exec("SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid").one();
          return info;
        },
      };
    },
  };
}

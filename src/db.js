import { DatabaseSync } from "node:sqlite";
import { config } from "#hub/config";
import { createStore } from "./store.js";

const db = new DatabaseSync(config.dbFile);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;");
export const { bus, COLLECTIONS, validColl, validId, getDoc, listDocs, setDoc, updateDoc, deleteDoc, transaction, addEvent, listEvents, pruneEvents, agentStatus, channelStatus, getSession, touchSession, bumpSession, sessionsForTask, sessionsSince, kv, stats } = createStore(db);

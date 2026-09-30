import { current } from "./runtime.js";

const store = () => current().store;
const scoped = (name) => new Proxy({}, { get: (_, key) => {
  const value = store()[name][key];
  return typeof value === "function" ? value.bind(store()[name]) : value;
} });
export const bus = scoped("bus");
export const kv = scoped("kv");
export const COLLECTIONS = ["tasks", "rules", "retros", "config"];
export const validColl = (...a) => store().validColl(...a);
export const validId = (...a) => store().validId(...a);
export const getDoc = (...a) => store().getDoc(...a);
export const listDocs = (...a) => store().listDocs(...a);
export const setDoc = (...a) => store().setDoc(...a);
export const updateDoc = (...a) => store().updateDoc(...a);
export const deleteDoc = (...a) => store().deleteDoc(...a);
export const transaction = (...a) => store().transaction(...a);
export const addEvent = (...a) => store().addEvent(...a);
export const listEvents = (...a) => store().listEvents(...a);
export const pruneEvents = (...a) => store().pruneEvents(...a);
export const agentStatus = (...a) => store().agentStatus(...a);
export const channelStatus = (...a) => store().channelStatus(...a);
export const getSession = (...a) => store().getSession(...a);
export const touchSession = (...a) => store().touchSession(...a);
export const bumpSession = (...a) => store().bumpSession(...a);
export const sessionsForTask = (...a) => store().sessionsForTask(...a);
export const sessionsSince = (...a) => store().sessionsSince(...a);
export const stats = (...a) => store().stats(...a);

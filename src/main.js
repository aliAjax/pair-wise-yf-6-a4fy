import "./styles.css";
import {
  loadState,
  saveState,
  currentDevice,
  commitRepairEdit,
  syncAll,
  resolveConflict,
  approveBudget,
  createPayment,
  retryPayment
} from "./store.js";
import { renderApp, bindEvents } from "./ui.js";

const state = loadState(localStorage);
if (state.simulateFail === undefined) state.simulateFail = false;
if (!state.ui) state.ui = { modal: null };

const app = document.querySelector("#app");

function persist() {
  saveState(localStorage, state);
}

function rerender() {
  app.innerHTML = renderApp(state);
  bindEvents(state, actions);
}

const actions = {
  setDevice(id) {
    state.currentDeviceId = id;
    persist();
    rerender();
  },
  toggleOnline() {
    state.online = !state.online;
    persist();
    rerender();
  },
  setSimulateFail(value) {
    state.simulateFail = value;
    persist();
    rerender();
  },
  setFilter(filter) {
    state.filter = filter;
    persist();
    rerender();
  },
  sync() {
    syncAll(state);
    persist();
    const pending = state.conflicts.find((c) => c.status === "pending");
    if (pending) state.ui = { modal: "conflict", conflictId: pending.id };
    rerender();
  },
  saveNew(fields) {
    const device = currentDevice(state);
    commitRepairEdit(state, device, fields, null);
    persist();
    rerender();
  },
  saveField(repairId, fields) {
    const device = currentDevice(state);
    const repair = state.repairs.find((r) => r.id === repairId);
    if (!repair) return;
    commitRepairEdit(state, device, fields, repair);
    persist();
    rerender();
  },
  saveEdit(fields) {
    const device = currentDevice(state);
    const repair = state.repairs.find((r) => r.id === state.ui.repairId);
    if (!repair) return;
    commitRepairEdit(state, device, fields, repair);
    state.ui = { modal: null };
    persist();
    rerender();
  },
  deleteRepair(repairId) {
    state.repairs = state.repairs.filter((r) => r.id !== repairId);
    delete state.payments[repairId];
    state.conflicts = state.conflicts.filter((c) => c.repairId !== repairId);
    persist();
    rerender();
  },
  approveBudget(repairId) {
    approveBudget(state, repairId, currentDevice(state).id);
    persist();
    rerender();
  },
  createPayment(repairId) {
    createPayment(state, repairId, { forceFail: state.simulateFail });
    persist();
    rerender();
  },
  retryPayment(repairId) {
    retryPayment(state, repairId, { forceFail: false });
    persist();
    rerender();
  },
  openEdit(repairId) {
    state.ui = { modal: "edit", repairId };
    rerender();
  },
  openConflict() {
    const conflict = state.conflicts.find((c) => c.status === "pending");
    state.ui = { modal: "conflict", conflictId: conflict ? conflict.id : null };
    rerender();
  },
  closeModal() {
    state.ui = { modal: null };
    rerender();
  },
  resolveConflict(conflictId, choice) {
    resolveConflict(state, conflictId, choice);
    state.ui = { modal: null };
    persist();
    rerender();
  }
};

rerender();

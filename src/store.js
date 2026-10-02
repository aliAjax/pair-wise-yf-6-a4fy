// 核心状态与协作逻辑（纯函数为主，便于测试）
// - 离线进度按「设备号 + 批次序号」合并，已合并批次幂等不重复
// - 两台设备同时改同一事项 -> 保留两版等户主裁定
// - 报价变更 -> 已批准预算失效，事项退回待审批
// - 付款失败保留现场，重试只更新同一条付款记录（不新增）

import { STORAGE_KEY, defaultDevices } from "./config.js";

export function createInitialState() {
  const now = Date.now();
  return {
    version: 2,
    currentDeviceId: "d-owner",
    online: true,
    simulateFail: false,
    filter: "all",
    ui: { modal: null },
    devices: defaultDevices.map((d) => ({ ...d })),
    repairs: [
      {
        id: crypto.randomUUID(),
        location: "厨房",
        title: "水槽下方渗水",
        priority: "high",
        photo: "",
        note: "先检查软管接口，师傅报价 260",
        status: "pending_approval",
        quoteAmount: 260,
        approvedBudget: null,
        version: 1,
        updatedBy: "d-owner",
        createdAt: now
      }
    ],
    // 每个事项最多一条付款记录（重试只更新它，不新增）
    payments: {},
    conflicts: [],
    // 每台设备的离线待同步队列
    outboxes: { "d-owner": [], "d-family": [], "d-master": [] },
    // 已合并的批次号（幂等键：deviceId -> batchSeq 列表）
    appliedBatches: { "d-owner": [], "d-family": [], "d-master": [] }
  };
}

export function loadState(storage) {
  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.repairs) && Array.isArray(parsed.devices)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn("读取本地状态失败，已重置", err);
  }
  return createInitialState();
}

export function saveState(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function currentDevice(state) {
  return state.devices.find((d) => d.id === state.currentDeviceId) || state.devices[0];
}

function deviceNameOf(state, deviceId) {
  const d = state.devices.find((x) => x.id === deviceId);
  return d ? d.name : "未知设备";
}

function nextBatchSeq(state, deviceId) {
  const applied = state.appliedBatches[deviceId] || [];
  const pending = (state.outboxes[deviceId] || []).map((e) => e.batchSeq);
  return Math.max(0, ...applied, ...pending) + 1;
}

// 应用一个补丁到事项上；若报价变更且曾批准预算，则预算失效、状态退回待审批
function applyPatch(repair, patch, deviceId) {
  const quoteChanged =
    patch.quoteAmount !== undefined &&
    Number(patch.quoteAmount) !== Number(repair.quoteAmount);
  Object.assign(repair, patch, {
    version: repair.version + 1,
    updatedBy: deviceId,
    updatedAt: Date.now()
  });
  if (quoteChanged && repair.approvedBudget != null && repair.approvedBudget !== Number(repair.quoteAmount)) {
    repair.status = "pending_approval";
  }
}

// 提交一次事项编辑：在线直接生效；离线进入该设备的待同步队列
export function commitRepairEdit(state, device, fields, existingRepair) {
  if (state.online) {
    if (existingRepair) {
      applyPatch(existingRepair, fields, device.id);
    } else {
      state.repairs.unshift({
        ...fields,
        id: crypto.randomUUID(),
        version: 1,
        updatedBy: device.id,
        createdAt: Date.now(),
        approvedBudget: null
      });
    }
    return { queued: false };
  }

  // 离线：写入待同步队列，不改动共享状态
  if (!state.outboxes[device.id]) state.outboxes[device.id] = [];
  const seq = nextBatchSeq(state, device.id);
  if (existingRepair) {
    state.outboxes[device.id].push({
      batchSeq: seq,
      op: "update",
      repairId: existingRepair.id,
      patch: { ...fields },
      baseVersion: existingRepair.version,
      baseSnapshot: { ...existingRepair },
      at: Date.now(),
      status: "pending"
    });
  } else {
    const id = crypto.randomUUID();
    state.outboxes[device.id].push({
      batchSeq: seq,
      op: "create",
      repairId: id,
      patch: { ...fields, id, approvedBudget: null },
      baseVersion: null,
      baseSnapshot: null,
      at: Date.now(),
      status: "pending"
    });
  }
  return { queued: true, batchSeq: seq };
}

// 合并所有设备的离线队列（回网同步）
// 返回本次新产生的冲突列表
export function syncAll(state) {
  const newConflicts = [];

  for (const device of state.devices) {
    const outbox = state.outboxes[device.id] || [];
    for (const entry of outbox) {
      if (entry.status !== "pending") continue; // 已合并或已被冲突挂起
      const seqs = state.appliedBatches[device.id] || (state.appliedBatches[device.id] = []);

      // 幂等：同一设备同一批次号只合并一次
      if (seqs.includes(entry.batchSeq)) {
        entry.status = "applied";
        continue;
      }

      if (entry.op === "create") {
        if (!state.repairs.some((r) => r.id === entry.repairId)) {
          state.repairs.unshift({
            ...entry.patch,
            id: entry.repairId,
            version: 1,
            updatedBy: device.id,
            createdAt: entry.at
          });
        }
        seqs.push(entry.batchSeq);
        entry.status = "applied";
        continue;
      }

      // update
      const repair = state.repairs.find((r) => r.id === entry.repairId);
      if (!repair) {
        // 事项已被删除，跳过
        seqs.push(entry.batchSeq);
        entry.status = "applied";
        continue;
      }

      if (repair.version === entry.baseVersion || repair.updatedBy === device.id) {
        // 版本未变 -> 快进；或同一设备自己的连续离线批次 -> 直接覆盖
        applyPatch(repair, entry.patch, device.id);
        seqs.push(entry.batchSeq);
        entry.status = "applied";
      } else {
        // 版本不一致且最后修改者是另一台设备 -> 冲突，保留两版等户主裁定
        const conflict = holdConflict(state, repair, entry, device);
        if (conflict) {
          newConflicts.push(conflict);
          entry.status = "conflict";
        } else {
          // 该事项已有待裁定冲突，本批次视为被取代
          seqs.push(entry.batchSeq);
          entry.status = "applied";
        }
      }
    }
  }
  return newConflicts;
}

function holdConflict(state, repair, entry, device) {
  const existing = state.conflicts.find((c) => c.repairId === repair.id && c.status === "pending");
  if (existing) return null;

  // A 版：当前共享版（另一台设备刚写入的）
  // B 版：离线设备基于 baseSnapshot + 自己的 patch 想要提交的版本
  const versionA = { ...repair };
  const versionB = { ...entry.baseSnapshot, ...entry.patch, id: repair.id };

  const conflict = {
    id: crypto.randomUUID(),
    repairId: repair.id,
    createdAt: Date.now(),
    status: "pending",
    chosenIndex: null,
    versions: [
      {
        deviceId: repair.updatedBy,
        deviceName: deviceNameOf(state, repair.updatedBy),
        snapshot: versionA,
        at: repair.updatedAt || repair.createdAt
      },
      {
        deviceId: device.id,
        deviceName: device.name,
        snapshot: versionB,
        at: entry.at
      }
    ]
  };
  state.conflicts.push(conflict);
  return conflict;
}

// 户主裁定冲突：chosenIndex 0=采用当前共享版A，1=采用离线提交版B
export function resolveConflict(state, conflictId, chosenIndex) {
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict || conflict.status !== "pending") return;

  const repair = state.repairs.find((r) => r.id === conflict.repairId);
  if (repair && chosenIndex === 1) {
    const snap = { ...conflict.versions[chosenIndex].snapshot };
    state.repairs = state.repairs.map((r) =>
      r.id === repair.id
        ? { ...snap, id: repair.id, version: repair.version + 1, updatedBy: state.currentDeviceId, updatedAt: Date.now() }
        : r
    );
  }
  // chosenIndex === 0：保持当前共享版 A 不变

  conflict.status = "resolved";
  conflict.chosenIndex = chosenIndex;

  // 挂起的离线批次随之结案（无论采用哪版，该批次都已处理）
  for (const device of state.devices) {
    const held = (state.outboxes[device.id] || []).find(
      (e) => e.repairId === conflict.repairId && e.status === "conflict"
    );
    if (held) {
      held.status = "applied";
      const seqs = state.appliedBatches[device.id] || (state.appliedBatches[device.id] = []);
      if (!seqs.includes(held.batchSeq)) seqs.push(held.batchSeq);
    }
  }
}

// 报价变更（师傅/户主）：走 applyPatch，触发预算失效联动
export function changeQuote(state, repairId, newAmount, deviceId) {
  const repair = state.repairs.find((r) => r.id === repairId);
  if (!repair) return;
  applyPatch(repair, { quoteAmount: Number(newAmount) || 0 }, deviceId);
}

// 户主批准预算：冻结当前报价作为批准预算
export function approveBudget(state, repairId, deviceId) {
  const repair = state.repairs.find((r) => r.id === repairId);
  if (!repair) return;
  repair.approvedBudget = Number(repair.quoteAmount) || 0;
  repair.status = "approved";
  repair.version += 1;
  repair.updatedBy = deviceId;
  repair.updatedAt = Date.now();
}

// 预算状态：none=未批准 / valid=已批准且报价一致 / invalid=报价变更已失效
export function budgetState(repair) {
  if (repair.approvedBudget == null) return "none";
  return Number(repair.approvedBudget) === Number(repair.quoteAmount) ? "valid" : "invalid";
}

// 发起付款：每个事项只建一条；若已存在则直接返回（幂等）
export function createPayment(state, repairId, opts = {}) {
  if (state.payments[repairId]) return state.payments[repairId];
  const repair = state.repairs.find((r) => r.id === repairId);
  const amount = repair ? Number(repair.quoteAmount) || Number(repair.approvedBudget) || 0 : 0;
  const payment = {
    id: crypto.randomUUID(),
    repairId,
    amount,
    method: opts.method || "wechat",
    status: "pending",
    attempts: 0,
    failReason: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    paidAt: null
  };
  state.payments[repairId] = payment;
  attemptPayment(payment, opts.forceFail);
  return payment;
}

// 重试付款：只更新同一条记录的尝试次数与状态，不新增记录
export function retryPayment(state, repairId, opts = {}) {
  const payment = state.payments[repairId];
  if (!payment || payment.status !== "failed") return payment;
  attemptPayment(payment, opts.forceFail);
  return payment;
}

function attemptPayment(payment, forceFail) {
  payment.attempts += 1;
  payment.updatedAt = Date.now();
  if (forceFail) {
    payment.status = "failed";
    payment.failReason = "模拟失败：支付渠道超时，请重试";
  } else {
    payment.status = "paid";
    payment.failReason = "";
    payment.paidAt = Date.now();
  }
}

export function pendingOutboxCount(state) {
  return state.devices.reduce((total, d) => {
    const pending = (state.outboxes[d.id] || []).filter((e) => e.status === "pending").length;
    return total + pending;
  }, 0);
}

export function pendingConflictCount(state) {
  return state.conflicts.filter((c) => c.status === "pending").length;
}

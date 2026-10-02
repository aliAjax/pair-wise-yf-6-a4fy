// 协作内核：所有变更都先落成操作（op），再按「设备号 + 批次序号」确定性合并。
// 每台设备用同一条操作日志重放出同一份状态；离线期间的操作先存本地队列，
// 回网后作为一个批次（一个批次序号）提交合并。

export const LOG_KEY = "zfl14.log.v1";
const DEVICE_KEY = "zfl14.device.v1";
const OUTBOX_PREFIX = "zfl14.outbox.";

// ---------- 设备身份（每个标签页即一台设备） ----------
export function getDevice() {
  const raw = sessionStorage.getItem(DEVICE_KEY);
  if (raw) return JSON.parse(raw);
  const device = {
    id: "dev-" + Math.random().toString(36).slice(2, 6),
    name: "设备-" + Math.random().toString(36).slice(2, 6).toUpperCase()
  };
  sessionStorage.setItem(DEVICE_KEY, JSON.stringify(device));
  return device;
}

export function renameDevice(name) {
  const device = { ...getDevice(), name };
  sessionStorage.setItem(DEVICE_KEY, JSON.stringify(device));
  return device;
}

// ---------- 共享操作日志（模拟服务端，同一浏览器各标签页共享） ----------
export function readLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY)) || [];
  } catch {
    return [];
  }
}

export function writeLog(log) {
  localStorage.setItem(LOG_KEY, JSON.stringify(log));
}

// ---------- 本机离线队列 ----------
function outboxKey() {
  return OUTBOX_PREFIX + getDevice().id;
}

export function readOutbox() {
  try {
    return JSON.parse(localStorage.getItem(outboxKey())) || [];
  } catch {
    return [];
  }
}

export function enqueueOp(op) {
  localStorage.setItem(outboxKey(), JSON.stringify([...readOutbox(), op]));
}

export function clearOutbox() {
  localStorage.removeItem(outboxKey());
}

export function nextBatchSeq(log, deviceId) {
  let max = 0;
  for (const batch of log) {
    if (batch.deviceId === deviceId) max = Math.max(max, batch.batchSeq);
  }
  return max + 1;
}

export function appendBatch(ops) {
  const device = getDevice();
  const log = readLog();
  const batch = {
    deviceId: device.id,
    deviceName: device.name,
    batchSeq: nextBatchSeq(log, device.id),
    at: Date.now(),
    ops
  };
  writeLog([...log, batch]);
  return batch;
}

// 回网：离线队列整体作为一个批次提交
export function flushOutbox() {
  const ops = readOutbox();
  if (!ops.length) return null;
  const batch = appendBatch(ops);
  clearOutbox();
  return batch;
}

// 派发操作：在线直接入日志（先把离线队列冲刷出去，保证顺序），离线进本地队列
export function dispatch(op, online) {
  if (online) {
    flushOutbox();
    appendBatch([op]);
    return "synced";
  }
  enqueueOp(op);
  return "queued";
}

// ---------- 合并：按设备号 + 批次序号排序后重放 ----------
function cmpBatch(a, b) {
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return a.batchSeq - b.batchSeq;
}

export function reduceLog(log) {
  const state = { repairs: [], conflicts: [], payments: [], batches: [] };
  const batches = [...log].sort(cmpBatch);
  for (const batch of batches) {
    state.batches.push({
      deviceId: batch.deviceId,
      deviceName: batch.deviceName,
      batchSeq: batch.batchSeq,
      at: batch.at,
      opCount: batch.ops.length,
      pending: !!batch.pending
    });
    batch.ops.forEach((op, idx) => applyOp(state, op, batch, idx));
  }
  return state;
}

function findRepair(state, id) {
  return state.repairs.find((r) => r.id === id);
}

function applyOp(state, op, batch, idx) {
  const from = { id: batch.deviceId, name: batch.deviceName, batchSeq: batch.batchSeq };
  const pending = !!batch.pending; // 本机离线队列的乐观应用，不参与冲突判定
  switch (op.type) {
    case "repair.create": {
      if (findRepair(state, op.repair.id)) return;
      state.repairs.unshift({
        ...op.repair,
        rev: 1,
        quote: null,
        approval: { status: "none" },
        progress: [],
        createdBy: from,
        updatedBy: from,
        pending
      });
      break;
    }
    case "repair.update": {
      const repair = findRepair(state, op.repairId);
      if (!repair) return;
      if (pending || repair.rev === op.baseRev) {
        Object.assign(repair, op.patch);
        repair.rev += 1;
        repair.updatedBy = from;
        if (pending) repair.pending = true;
      } else {
        // 两台设备同时改了同一事项：保留对方版本，等户主裁定
        state.conflicts.push(makeConflict(op, from, idx));
      }
      break;
    }
    case "repair.delete": {
      state.repairs = state.repairs.filter((r) => r.id !== op.repairId);
      state.payments = state.payments.filter((p) => p.repairId !== op.repairId);
      for (const c of state.conflicts) {
        if (c.repairId === op.repairId && c.status === "pending") c.status = "void";
      }
      break;
    }
    case "progress.add": {
      const repair = findRepair(state, op.repairId);
      if (!repair) return;
      repair.progress.push({ ...op.entry, device: from, pending });
      // 进度按设备号 + 批次序号合并排序
      repair.progress.sort((a, b) => {
        if (a.device.id !== b.device.id) return a.device.id < b.device.id ? -1 : 1;
        return a.device.batchSeq - b.device.batchSeq;
      });
      break;
    }
    case "quote.submit": {
      const repair = findRepair(state, op.repairId);
      if (!repair) return;
      const quote = {
        amount: Number(op.quote.amount),
        technician: op.quote.technician,
        note: op.quote.note || "",
        at: op.at,
        by: from,
        rev: (repair.quote ? repair.quote.rev : 0) + 1
      };
      if (pending || repair.rev === op.baseRev) {
        applyQuote(repair, quote);
        repair.rev += 1;
        repair.updatedBy = from;
        if (pending) repair.pending = true;
      } else {
        state.conflicts.push(makeConflict({ ...op, patch: { quote } }, from, idx));
      }
      break;
    }
    case "approval.approve": {
      const repair = findRepair(state, op.repairId);
      if (!repair || !repair.quote) return;
      if (repair.quote.rev !== op.quoteRev) {
        // 批准时的报价已被新报价替换，这份批复直接失效
        repair.approval = {
          status: "pending",
          invalidated: true,
          prevApproved: { amount: op.amount, quoteRev: op.quoteRev, at: op.at }
        };
        return;
      }
      repair.approval = {
        status: "approved",
        amount: repair.quote.amount,
        quoteRev: repair.quote.rev,
        by: op.by,
        at: op.at
      };
      break;
    }
    case "payment.pay":
    case "payment.retry": {
      // 同一 attemptKey 只对应一条付款记录：重试只更新，不新增
      const existing = state.payments.find((p) => p.attemptKey === op.attemptKey);
      if (existing) {
        if (existing.status === "success") return; // 已成功，重试不再变更
        existing.attempts += 1;
        existing.status = op.outcome;
        existing.error = op.error || null;
        existing.updatedAt = op.at;
        existing.history.push({ at: op.at, outcome: op.outcome, error: op.error || null, kind: "retry" });
      } else {
        state.payments.push({
          id: "pay-" + op.attemptKey,
          attemptKey: op.attemptKey,
          repairId: op.repairId,
          amount: Number(op.amount),
          method: op.method,
          note: op.note || "",
          status: op.outcome,
          attempts: 1,
          error: op.error || null,
          history: [{ at: op.at, outcome: op.outcome, error: op.error || null, kind: "pay" }],
          createdBy: from,
          createdAt: op.at,
          updatedAt: op.at
        });
      }
      break;
    }
    case "conflict.resolve": {
      const conflict = state.conflicts.find((c) => c.id === op.conflictId);
      if (!conflict || conflict.status !== "pending") return;
      conflict.status = "resolved";
      conflict.choice = op.choice;
      conflict.resolvedBy = op.by;
      conflict.resolvedAt = op.at;
      if (op.choice === "take") {
        const repair = findRepair(state, conflict.repairId);
        if (!repair) return;
        if (conflict.patch.quote) {
          applyQuote(repair, {
            ...conflict.patch.quote,
            rev: (repair.quote ? repair.quote.rev : 0) + 1
          });
        } else {
          Object.assign(repair, conflict.patch);
        }
        repair.rev += 1;
        repair.updatedBy = conflict.from;
      }
      break;
    }
  }
}

// 报价一变，先前批准的预算失效，事项退回待审批
function applyQuote(repair, quote) {
  repair.quote = quote;
  if (repair.approval.status === "approved") {
    repair.approval = {
      status: "pending",
      invalidated: true,
      prevApproved: { amount: repair.approval.amount, quoteRev: repair.approval.quoteRev, at: repair.approval.at }
    };
  } else if (repair.approval.status === "none") {
    repair.approval = { status: "pending" };
  }
}

function makeConflict(op, from, idx) {
  return {
    id: `cf-${from.id}-${from.batchSeq}-${idx}`,
    repairId: op.repairId,
    patch: op.patch,
    from,
    at: op.at,
    status: "pending"
  };
}

// ---------- 演示数据 ----------
export function seedLog() {
  const t = Date.now();
  const create = (id, location, title, priority, status, cost, note) => ({
    type: "repair.create",
    repair: { id, location, title, priority, status, cost, note, photo: "" },
    at: t
  });
  return [
    {
      deviceId: "00-seed",
      deviceName: "系统初始化",
      batchSeq: 1,
      at: t,
      ops: [
        create("r-kitchen", "厨房", "水槽下方渗水，柜体受潮", "high", "doing", 300, "先检查软管接口"),
        { type: "quote.submit", repairId: "r-kitchen", baseRev: 1, quote: { amount: 260, technician: "王师傅", note: "含软管更换" }, at: t },
        { type: "approval.approve", repairId: "r-kitchen", quoteRev: 1, amount: 260, by: "户主", at: t },
        { type: "payment.pay", repairId: "r-kitchen", attemptKey: "seed-pay-1", amount: 260, method: "微信", note: "材料+人工", outcome: "success", error: null, at: t },
        { type: "progress.add", repairId: "r-kitchen", entry: { id: "sp-1", text: "王师傅周六上门，上门前先关总阀", at: t }, at: t },
        create("r-bath", "卫生间", "门锁松动，关不严", "medium", "todo", 150, ""),
        { type: "quote.submit", repairId: "r-bath", baseRev: 1, quote: { amount: 120, technician: "李师傅", note: "换锁体" }, at: t },
        create("r-balcony", "阳台", "地砖两处起鼓", "low", "todo", 0, "等邻居推荐师傅")
      ]
    }
  ];
}

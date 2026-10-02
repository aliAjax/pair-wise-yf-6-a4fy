// 核心逻辑验证（node 直接运行：node verify.mjs）
import {
  createInitialState,
  commitRepairEdit,
  syncAll,
  resolveConflict,
  changeQuote,
  approveBudget,
  budgetState,
  createPayment,
  retryPayment,
  pendingOutboxCount,
  pendingConflictCount
} from "./src/store.js";

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log("  PASS", name);
  } else {
    failed++;
    console.log("  FAIL", name);
  }
}

// 1. 离线编辑进入队列，不改共享状态；回网按批次合并
{
  const state = createInitialState();
  const owner = state.devices[0];
  const repair = state.repairs[0];
  state.online = false;
  commitRepairEdit(state, owner, { note: "离线补充：角阀也老化了" }, repair);
  check("离线编辑进入待同步队列", pendingOutboxCount(state) === 1);
  check("离线时共享状态未变", state.repairs[0].note === "先检查软管接口，师傅报价 260");
  state.online = true;
  syncAll(state);
  check("回网同步后共享状态更新", state.repairs[0].note === "离线补充：角阀也老化了");
  check("同步后队列清空", pendingOutboxCount(state) === 0);
}

// 2. 同一批次重复同步幂等，不重复应用
{
  const state = createInitialState();
  const owner = state.devices[0];
  const repair = state.repairs[0];
  state.online = false;
  commitRepairEdit(state, owner, { note: "批次1" }, repair);
  state.online = true;
  syncAll(state);
  const v1 = state.repairs[0].version;
  // 手动把已应用条目标记回 pending 模拟重放
  state.outboxes[owner.id][0].status = "pending";
  syncAll(state);
  check("重复批次不重复应用（版本不变）", state.repairs[0].version === v1);
}

// 3. 两台设备离线改同一事项 -> 冲突，保留两版
{
  const state = createInitialState();
  const owner = state.devices[0];
  const master = state.devices[2];
  const repair = state.repairs[0];
  state.online = false;
  commitRepairEdit(state, owner, { note: "户主版备注" }, repair);
  commitRepairEdit(state, master, { note: "师傅版备注" }, repair);
  state.online = true;
  const newConflicts = syncAll(state);
  check("两台设备同时修改产生 1 个冲突", newConflicts.length === 1 && pendingConflictCount(state) === 1);
  const conflict = state.conflicts[0];
  check("冲突保留两版", conflict.versions.length === 2);
  check("A 版是户主设备", conflict.versions[0].deviceId === owner.id);
  check("B 版是师傅设备", conflict.versions[1].deviceId === master.id);
  check("共享状态仍是 A 版（户主版）", state.repairs[0].note === "户主版备注");
  // 户主裁定采用 B 版（师傅版）
  resolveConflict(state, conflict.id, 1);
  check("裁定采用B版后状态更新", state.repairs[0].note === "师傅版备注");
  check("冲突已结案", pendingConflictCount(state) === 0);
}

// 4. 报价变更 -> 已批准预算失效，事项退回待审批
{
  const state = createInitialState();
  const owner = state.devices[0];
  const repair = state.repairs[0];
  approveBudget(state, repair.id, owner.id);
  check("批准后预算有效", budgetState(state.repairs[0]) === "valid" && state.repairs[0].status === "approved");
  changeQuote(state, repair.id, 320, owner.id);
  check("报价变更后预算失效", budgetState(state.repairs[0]) === "invalid");
  check("事项退回待审批", state.repairs[0].status === "pending_approval");
  check("原批准预算金额保留用于展示", state.repairs[0].approvedBudget === 260);
}

// 5. 付款失败保留现场，重试只生成一条记录
{
  const state = createInitialState();
  const owner = state.devices[0];
  const repair = state.repairs[0];
  const p1 = createPayment(state, repair.id, { forceFail: true, method: "wechat" });
  check("首次付款失败", p1.status === "failed" && p1.attempts === 1);
  check("失败原因保留", p1.failReason.length > 0);
  check("付款记录只有一条", Object.keys(state.payments).length === 1);
  // 重试
  const p2 = retryPayment(state, repair.id, {});
  check("重试仍是同一条记录", p2.id === p1.id);
  check("重试后已支付且尝试次数为2", p2.status === "paid" && p2.attempts === 2);
  check("重试不新增记录", Object.keys(state.payments).length === 1);
  // 再次重试已支付的记录无效
  const p3 = retryPayment(state, repair.id, {});
  check("已支付后重试不改变状态", p3.status === "paid" && p3.attempts === 2);
}

// 6. 在线直接编辑立即生效并自增版本
{
  const state = createInitialState();
  const owner = state.devices[0];
  const repair = state.repairs[0];
  commitRepairEdit(state, owner, { note: "在线直接改" }, repair);
  check("在线编辑立即生效", state.repairs[0].note === "在线直接改");
  check("在线编辑版本自增", state.repairs[0].version === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// 渲染冒烟测试：用初始状态跑 renderApp，检查关键内容是否输出
import { createInitialState, commitRepairEdit, syncAll, changeQuote, approveBudget, createPayment } from "./src/store.js";
import { renderApp } from "./src/ui.js";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name); }
}

// 1. 初始状态渲染
{
  const state = createInitialState();
  const html = renderApp(state);
  check("渲染标题", html.includes("家庭维修事项"));
  check("渲染设备选择", html.includes("户主手机"));
  check("渲染维修事项", html.includes("水槽下方渗水"));
  check("渲染报价", html.includes("¥260"));
  check("渲染待审批状态", html.includes("待审批"));
  check("渲染新增表单", html.includes("新增维修事项"));
  check("渲染待同步批次区", html.includes("待同步批次"));
}

// 2. 离线编辑后渲染（显示待同步批次）
{
  const state = createInitialState();
  const owner = state.devices[0];
  const repair = state.repairs[0];
  state.online = false;
  commitRepairEdit(state, owner, { note: "离线补充备注" }, repair);
  const html = renderApp(state);
  check("离线后渲染待同步批次数", html.includes("1 批待合并"));
  check("离线后仍显示原备注（未合并）", html.includes("先检查软管接口"));
}

// 3. 冲突后渲染（显示冲突横幅 + 裁定弹窗）
{
  const state = createInitialState();
  const owner = state.devices[0];
  const master = state.devices[2];
  const repair = state.repairs[0];
  state.online = false;
  commitRepairEdit(state, owner, { note: "户主版" }, repair);
  commitRepairEdit(state, master, { note: "师傅版" }, repair);
  state.online = true;
  syncAll(state);
  state.ui = { modal: "conflict", conflictId: state.conflicts[0].id };
  const html = renderApp(state);
  check("渲染冲突横幅", html.includes("版本冲突待户主裁定") || html.includes("待户主裁定"));
  check("渲染冲突弹窗两版", html.includes("A 版") && html.includes("B 版"));
  check("渲染采用按钮", html.includes("采用 A 版") && html.includes("采用 B 版"));
}

// 4. 预算失效渲染
{
  const state = createInitialState();
  const owner = state.devices[0];
  const repair = state.repairs[0];
  approveBudget(state, repair.id, owner.id);
  changeQuote(state, repair.id, 320, owner.id);
  const html = renderApp(state);
  check("渲染预算失效", html.includes("预算失效"));
  check("渲染退回待审批", html.includes("待审批"));
}

// 5. 付款失败渲染（重试按钮 + 尝试次数）
{
  const state = createInitialState();
  const owner = state.devices[0];
  const repair = state.repairs[0];
  createPayment(state, repair.id, { forceFail: true });
  const html = renderApp(state);
  check("渲染支付失败", html.includes("支付失败"));
  check("渲染重试按钮", html.includes("重试付款"));
  check("渲染尝试次数", html.includes("重试 1 次"));
}

// 6. 角色视角：家人不可见金额
{
  const state = createInitialState();
  state.currentDeviceId = "d-family";
  const repair = state.repairs[0];
  const html = renderApp(state);
  check("家人视角预算显示 •••", html.includes("预算 •••"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

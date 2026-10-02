import "./styles.css";
import {
  LOG_KEY,
  getDevice,
  renameDevice,
  readLog,
  writeLog,
  readOutbox,
  clearOutbox,
  flushOutbox,
  dispatch,
  reduceLog,
  seedLog,
  nextBatchSeq
} from "./store.js";

const statusLabels = { todo: "待处理", doing: "处理中", done: "已完成" };
const filters = { all: "全部", todo: "待处理", doing: "处理中", done: "已完成", approving: "待审批", conflict: "有冲突" };
const priorities = { high: "高优先级", medium: "中优先级", low: "低优先级" };
const roleLabels = { owner: "户主", member: "成员", tech: "师傅" };
const payMethods = ["微信", "支付宝", "银行卡", "现金"];
const fieldLabels = {
  location: "位置",
  title: "问题描述",
  priority: "优先级",
  status: "状态",
  note: "备注",
  cost: "预估费用",
  photo: "照片链接",
  quote: "师傅报价"
};

const SNAP_KEY = "zfl14.snapshot";
let device = getDevice();
const ui = {
  role: localStorage.getItem("zfl14.role") || "owner",
  online: sessionStorage.getItem("zfl14.online") !== "0",
  filter: "all",
  simulateFail: false,
  editing: null,
  quoting: null,
  paying: null,
  progressFor: null
};

const app = document.querySelector("#app");

if (!localStorage.getItem(LOG_KEY)) writeLog(seedLog());
if (ui.online) flushOutbox();

// 离线期间看到的是断网时的快照，回网后才拉到其他设备的批次
function baseLog() {
  if (ui.online) return readLog();
  try {
    return JSON.parse(sessionStorage.getItem(SNAP_KEY)) || [];
  } catch {
    return [];
  }
}

// 本机视图 = 共享日志 + 本机离线队列（乐观应用，标记待同步）
function view() {
  const log = baseLog();
  const outbox = readOutbox();
  const batches = [...log];
  if (outbox.length) {
    batches.push({
      deviceId: device.id,
      deviceName: device.name,
      batchSeq: nextBatchSeq(log, device.id),
      at: Date.now(),
      ops: outbox,
      pending: true
    });
  }
  return reduceLog(batches);
}

function commit(op) {
  dispatch(op, ui.online);
  render();
}

function setOnline(online) {
  ui.online = online;
  sessionStorage.setItem("zfl14.online", online ? "1" : "0");
  if (online) {
    sessionStorage.removeItem(SNAP_KEY);
    flushOutbox();
  } else {
    sessionStorage.setItem(SNAP_KEY, JSON.stringify(readLog()));
  }
  render();
}

window.addEventListener("storage", () => {
  if (ui.online) render();
});

const findRepair = (v, id) => v.repairs.find((r) => r.id === id);

function render() {
  const v = view();
  const outboxCount = readOutbox().length;
  const pendingConflicts = v.conflicts.filter((c) => c.status === "pending");
  const failedPayments = v.payments.filter((p) => p.status === "failed");
  const paidTotal = v.payments.filter((p) => p.status === "success").reduce((s, p) => s + p.amount, 0);
  const approving = v.repairs.filter((r) => r.quote && r.approval.status === "pending").length;
  const unfinished = v.repairs.filter((r) => r.status !== "done").length;
  const list = filterRepairs(v, pendingConflicts);

  app.innerHTML = `
    <main class="shell">
      <header class="header">
        <div>
          <p class="eyebrow">家庭维修协作台</p>
          <h1>家庭维修事项</h1>
          <p class="hint">再开一个浏览器标签页就是另一台设备：离线写的进度会在回网后按「设备号 + 批次序号」合并；两台设备同时改同一事项会保留两版，由户主裁定。</p>
        </div>
        <section class="stats">
          <div class="stat"><span>未完成</span><strong>${unfinished}</strong></div>
          <div class="stat"><span>待审批</span><strong>${approving}</strong></div>
          <div class="stat"><span>冲突待裁定</span><strong>${pendingConflicts.length}</strong></div>
          <div class="stat"><span>待重试付款</span><strong>${failedPayments.length}</strong></div>
          <div class="stat"><span>已付合计</span><strong>¥${paidTotal}</strong></div>
        </section>
      </header>

      ${renderDeviceBar(outboxCount)}

      <section class="layout">
        ${renderAside()}
        <section>
          ${renderConflictPanel(v)}
          <div class="toolbar">
            ${Object.entries(filters)
              .map(([value, label]) => `<button class="seg ${ui.filter === value ? "active" : ""}" data-action="filter" data-filter="${value}">${label}</button>`)
              .join("")}
          </div>
          <div class="repairs">
            ${list.length ? list.map((r) => renderRepair(r, v)).join("") : `<div class="empty">当前筛选下没有维修事项</div>`}
          </div>
        </section>
      </section>

      <section class="bottom">
        ${renderExpenses(v)}
        ${renderSyncLog(v)}
      </section>
    </main>
  `;
}

function renderDeviceBar(outboxCount) {
  return `
    <div class="devicebar">
      <span>设备 <strong>${escapeHtml(device.name)}</strong> <span class="mini">${device.id}</span></span>
      <button class="ghost" data-action="rename-device">改名</button>
      <label class="inline-label">角色
        <select id="role-select">
          ${Object.entries(roleLabels)
            .map(([value, label]) => `<option value="${value}" ${ui.role === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </label>
      <button class="pill ${ui.online ? "on" : "off"}" data-action="toggle-online">${ui.online ? "● 在线" : "○ 离线"}</button>
      ${
        ui.online
          ? outboxCount
            ? `<button class="ghost" data-action="sync-now">立即同步（${outboxCount} 条）</button>`
            : `<span class="mini">离线队列为空，已同步</span>`
          : `<span class="badge warn">离线中 · 待同步 ${outboxCount} 条</span>`
      }
      <label class="inline-label mini"><input type="checkbox" id="simulate-fail" ${ui.simulateFail ? "checked" : ""}> 模拟付款失败</label>
      <span class="spacer"></span>
      <button class="ghost" data-action="reset-demo">重置演示数据</button>
    </div>`;
}

function renderAside() {
  if (ui.role === "tech") {
    return `<aside class="panel"><h2>新增维修事项</h2><p class="mini">师傅视角不能新建事项，可以在事项上提交报价、填写进度。切换到「户主」或「成员」可新建。</p></aside>`;
  }
  return `
    <aside class="panel">
      <h2>新增维修事项</h2>
      <form class="form" id="create-form">
        <label>位置<input name="location" required placeholder="例如卫生间"></label>
        <label>问题描述<textarea name="title" required placeholder="例如门锁松动"></textarea></label>
        <label>优先级<select name="priority">${options(priorities, "medium")}</select></label>
        <label>预估费用<input name="cost" type="number" min="0" step="1" value="0"></label>
        <label>处理状态<select name="status">${options(statusLabels, "todo")}</select></label>
        <label>照片链接<input name="photo" type="url" placeholder="可选，粘贴图片地址"></label>
        <label>备注<textarea name="note" placeholder="师傅电话、材料或注意事项"></textarea></label>
        <button class="primary" type="submit">保存事项${ui.online ? "" : "（离线，回网后合并）"}</button>
      </form>
    </aside>`;
}

function renderRepair(r, v) {
  const isOwner = ui.role === "owner";
  const canEdit = ui.role !== "tech";
  const canQuote = ui.role === "owner" || ui.role === "tech";
  const conflicts = v.conflicts.filter((c) => c.repairId === r.id && c.status === "pending");
  const payments = v.payments.filter((p) => p.repairId === r.id).sort((a, b) => a.createdAt - b.createdAt);
  const paid = payments.filter((p) => p.status === "success").reduce((s, p) => s + p.amount, 0);

  return `
    <article class="repair ${conflicts.length ? "has-conflict" : ""}">
      <div class="photo">${r.photo ? `<img src="${escapeHtml(r.photo)}" alt="${escapeHtml(r.location)}维修照片">` : "未添加照片"}</div>
      <div class="content">
        <div class="row">
          <h3>${escapeHtml(r.location)}</h3>
          <span class="priority ${r.priority}">${priorities[r.priority]}</span>
          <span class="status ${r.status}">${statusLabels[r.status]}</span>
          ${approvalBadge(r)}
          ${conflicts.length ? `<span class="badge err">冲突待裁定</span>` : ""}
          ${r.pending ? `<span class="badge info">有待同步修改</span>` : ""}
        </div>
        <p>${escapeHtml(r.title)}</p>
        <div class="row">
          <span class="chip">预估 ¥${Number(r.cost || 0)}</span>
          <span class="chip">${escapeHtml(r.note || "暂无备注")}</span>
          <span class="mini">最近更新：${escapeHtml(r.updatedBy.name)} · v${r.rev}</span>
        </div>

        <div class="block">
          <h4>师傅报价与预算审批</h4>
          ${renderQuote(r, canQuote)}
          ${renderApproval(r, isOwner)}
        </div>

        <div class="block">
          <h4>付款记录（已付 ¥${paid}）</h4>
          ${payments.length ? payments.map((p) => renderPayment(p, isOwner)).join("") : '<p class="mini">暂无付款记录</p>'}
          ${renderPayAction(r, isOwner, paid)}
        </div>

        <div class="block">
          <h4>进度（${r.progress.length}）</h4>
          ${r.progress.length ? `<ul class="progress-list">${r.progress.map(renderProgress).join("")}</ul>` : '<p class="mini">暂无进度</p>'}
          <div class="actions">
            <button class="ghost" data-action="progress-open" data-id="${r.id}">写进度</button>
          </div>
        </div>

        <div class="actions">
          ${canEdit ? `<select data-status-id="${r.id}">${options(statusLabels, r.status)}</select>` : ""}
          ${canEdit ? `<button class="ghost" data-action="edit-open" data-id="${r.id}">编辑</button>` : ""}
          ${isOwner ? `<button class="ghost" data-action="delete" data-id="${r.id}">删除</button>` : ""}
        </div>

        ${ui.editing === r.id ? editForm(r) : ""}
        ${ui.quoting === r.id ? quoteForm(r) : ""}
        ${ui.paying === r.id && r.approval.status === "approved" ? payForm(r, paid) : ""}
        ${ui.progressFor === r.id ? progressForm(r) : ""}
      </div>
    </article>`;
}

function renderQuote(r, canQuote) {
  const quote = r.quote
    ? `<div class="row">
        <span class="chip strong">报价 ¥${r.quote.amount}</span>
        <span class="chip">${escapeHtml(r.quote.technician)}</span>
        ${r.quote.note ? `<span class="chip">${escapeHtml(r.quote.note)}</span>` : ""}
        <span class="mini">${escapeHtml(r.quote.by.name)} · ${fmtTime(r.quote.at)}</span>
      </div>`
    : `<p class="mini">暂无报价</p>`;
  const btn = canQuote ? `<button class="ghost" data-action="quote-open" data-id="${r.id}">${r.quote ? "修改报价" : "提交报价"}</button>` : "";
  return `${quote}${btn ? `<div class="actions">${btn}</div>` : ""}`;
}

function renderApproval(r, isOwner) {
  if (!r.quote) return "";
  const a = r.approval;
  let text;
  if (a.status === "approved") {
    text = `<span class="badge ok">预算已批准 ¥${a.amount}</span><span class="mini">${escapeHtml(a.by || "")} · ${fmtTime(a.at)}</span>`;
  } else if (a.invalidated) {
    text = `<span class="badge warn">报价已变更，原批准预算 ¥${a.prevApproved.amount} 已失效，退回待审批</span>`;
  } else {
    text = `<span class="badge warn">待户主审批</span>`;
  }
  const btn =
    isOwner && a.status === "pending"
      ? `<button class="primary" data-action="approve" data-id="${r.id}">批准当前报价 ¥${r.quote.amount}</button>`
      : "";
  return `<div class="row">${text}</div>${btn ? `<div class="actions">${btn}</div>` : ""}`;
}

function renderPayment(p, isOwner) {
  const failed = p.status === "failed";
  return `
    <div class="payrow ${p.status}">
      <span>${failed ? "❌" : "✅"}</span>
      <span class="chip strong">¥${p.amount} · ${escapeHtml(p.method)}</span>
      ${p.note ? `<span class="chip">${escapeHtml(p.note)}</span>` : ""}
      <span class="mini">尝试 ${p.attempts} 次 · ${fmtTime(p.updatedAt)}</span>
      ${failed ? `<span class="badge err">失败：${escapeHtml(p.error || "未知原因")}</span><span class="mini">付款现场已保留，可直接重试</span>` : ""}
      ${failed && isOwner ? `<button class="ghost" data-action="retry-pay" data-attempt="${p.attemptKey}" ${ui.online ? "" : "disabled"}>重试付款</button>` : ""}
      ${failed && !isOwner ? `<span class="mini">等待户主重试</span>` : ""}
    </div>`;
}

function renderPayAction(r, isOwner, paid) {
  if (!isOwner || r.approval.status !== "approved") return "";
  if (!ui.online) return `<p class="mini">离线时不能付款，回网后再操作。</p>`;
  return `<div class="actions"><button class="ghost" data-action="pay-open" data-id="${r.id}">付款（预算 ¥${r.approval.amount} · 已付 ¥${paid}）</button></div>`;
}

function renderProgress(e) {
  return `<li>
    <span class="mini">${escapeHtml(e.device.name)} · 批次#${e.device.batchSeq} · ${fmtTime(e.at)}${e.pending ? ' · <b class="pend">待同步</b>' : ""}</span>
    <div>${escapeHtml(e.text)}</div>
  </li>`;
}

function renderConflictPanel(v) {
  const pending = v.conflicts.filter((c) => c.status === "pending");
  if (!pending.length) return "";
  const resolved = v.conflicts.length - pending.length;
  return `<section class="panel conflict-panel">
    <h2>冲突待裁定（${pending.length}）</h2>
    <p class="mini">两台设备同时修改了同一事项，两个版本都已保留，由户主裁定采用哪一版。${resolved ? `已裁定 ${resolved} 条。` : ""}</p>
    ${pending.map((c) => renderConflict(c, v)).join("")}
  </section>`;
}

function renderConflict(c, v) {
  const r = findRepair(v, c.repairId);
  if (!r) return "";
  const rows = Object.entries(c.patch)
    .map(
      ([field, val]) => `
    <tr>
      <td>${fieldLabels[field] || field}</td>
      <td>${fmtField(field, field === "quote" ? r.quote : r[field])}</td>
      <td>${fmtField(field, val)}</td>
    </tr>`
    )
    .join("");
  const isOwner = ui.role === "owner";
  return `<div class="conflict">
    <div class="row">
      <strong>${escapeHtml(r.location)} · ${escapeHtml(r.title)}</strong>
      <span class="mini">对方版本来自 ${escapeHtml(c.from.name)}（${c.from.id}）批次#${c.from.batchSeq} · ${fmtTime(c.at)}</span>
    </div>
    <table class="table">
      <thead><tr><th>字段</th><th>当前版本</th><th>对方版本</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${
      isOwner
        ? `<div class="actions">
            <button class="ghost" data-action="conflict-keep" data-conflict="${c.id}">保留当前版本</button>
            <button class="primary" data-action="conflict-take" data-conflict="${c.id}">采用对方版本</button>
          </div>`
        : `<p class="mini">等待户主裁定</p>`
    }
  </div>`;
}

function renderExpenses(v) {
  const rows = v.repairs
    .map((r) => {
      const pays = v.payments.filter((p) => p.repairId === r.id);
      const paid = pays.filter((p) => p.status === "success").reduce((s, p) => s + p.amount, 0);
      return { r, pays, paid };
    })
    .filter((x) => x.r.quote || x.pays.length);

  let body = "";
  if (ui.role === "owner") {
    const quoteSum = rows.reduce((s, x) => s + (x.r.quote ? x.r.quote.amount : 0), 0);
    const approvedSum = rows.reduce((s, x) => s + (x.r.approval.status === "approved" ? x.r.approval.amount : 0), 0);
    const paidSum = rows.reduce((s, x) => s + x.paid, 0);
    body = `<table class="table">
      <thead><tr><th>事项</th><th>师傅报价</th><th>审批状态</th><th>已批预算</th><th>已付</th><th>付款记录</th></tr></thead>
      <tbody>
        ${rows
          .map(
            ({ r, pays, paid }) => `<tr>
          <td>${escapeHtml(r.location)} · ${escapeHtml(r.title)}</td>
          <td>${r.quote ? "¥" + r.quote.amount : "—"}</td>
          <td>${approvalText(r)}</td>
          <td>${r.approval.status === "approved" ? "¥" + r.approval.amount : "—"}</td>
          <td>¥${paid}</td>
          <td>${
            pays.length
              ? pays
                  .map(
                    (p) =>
                      `<div class="mini">${p.status === "success" ? "✅" : "❌"} ¥${p.amount} ${escapeHtml(p.method)} · 尝试${p.attempts}次${p.status === "failed" ? " · 待重试" : ""}</div>`
                  )
                  .join("")
              : "—"
          }</td>
        </tr>`
          )
          .join("")}
      </tbody>
      <tfoot><tr><td>合计</td><td>¥${quoteSum}</td><td></td><td>¥${approvedSum}</td><td>¥${paidSum}</td><td>待付 ¥${Math.max(approvedSum - paidSum, 0)}</td></tr></tfoot>
    </table>`;
  } else if (ui.role === "member") {
    body = `<table class="table">
      <thead><tr><th>事项</th><th>师傅报价</th><th>审批状态</th><th>已付合计</th></tr></thead>
      <tbody>
        ${rows
          .map(
            ({ r, paid }) => `<tr>
          <td>${escapeHtml(r.location)} · ${escapeHtml(r.title)}</td>
          <td>${r.quote ? "¥" + r.quote.amount : "—"}</td>
          <td>${approvalText(r)}</td>
          <td>¥${paid}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>
    <p class="mini">成员视角：看得到报价与审批状态，看不到单笔付款方式与尝试次数。</p>`;
  } else {
    const qrows = rows.filter((x) => x.r.quote);
    body = `<table class="table">
      <thead><tr><th>事项</th><th>师傅报价</th><th>技师</th><th>报价状态</th></tr></thead>
      <tbody>
        ${qrows
          .map(
            ({ r }) => `<tr>
          <td>${escapeHtml(r.location)} · ${escapeHtml(r.title)}</td>
          <td>¥${r.quote.amount}</td>
          <td>${escapeHtml(r.quote.technician)}</td>
          <td>${approvalText(r)}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>
    <p class="mini">师傅视角：只看得到报价与报价状态，看不到预算批复金额与付款信息。</p>`;
  }
  return `<section class="panel"><h2>费用明细（${roleLabels[ui.role]}视角）</h2>${rows.length ? body : '<p class="mini">暂无报价与付款数据</p>'}</section>`;
}

function renderSyncLog(v) {
  const items = v.batches
    .map(
      (b, i) => `
    <li>
      <span class="chip">#${i + 1}</span>
      <strong>${escapeHtml(b.deviceName)}</strong>
      <span class="mini">${b.deviceId} · 批次 ${b.batchSeq} · ${b.opCount} 条操作 · ${fmtTime(b.at)}</span>
      ${b.deviceId === device.id ? '<span class="badge info">本机</span>' : ""}
      ${b.pending ? '<span class="badge warn">待同步</span>' : ""}
    </li>`
    )
    .join("");
  return `<section class="panel">
    <h2>同步日志</h2>
    <p class="mini">所有设备回网后，操作按「设备号 → 批次序号」的顺序合并，各端重放结果一致。</p>
    <ul class="synclog">${items}</ul>
  </section>`;
}

// ---------- 内联表单 ----------
function editForm(r) {
  return `<form class="inline-form" id="edit-form" data-id="${r.id}">
    <div class="grid2">
      <label>位置<input name="location" required value="${escapeHtml(r.location)}"></label>
      <label>优先级<select name="priority">${options(priorities, r.priority)}</select></label>
    </div>
    <label>问题描述<textarea name="title" required>${escapeHtml(r.title)}</textarea></label>
    <div class="grid2">
      <label>状态<select name="status">${options(statusLabels, r.status)}</select></label>
      <label>预估费用<input name="cost" type="number" min="0" step="1" value="${Number(r.cost || 0)}"></label>
    </div>
    <label>照片链接<input name="photo" type="url" value="${escapeHtml(r.photo || "")}"></label>
    <label>备注<textarea name="note">${escapeHtml(r.note || "")}</textarea></label>
    <div class="actions">
      <button class="primary" type="submit">保存修改${ui.online ? "" : "（离线，回网后合并）"}</button>
      <button class="ghost" type="button" data-action="edit-cancel">取消</button>
    </div>
  </form>`;
}

function quoteForm(r) {
  return `<form class="inline-form" id="quote-form" data-id="${r.id}">
    ${r.approval.status === "approved" ? '<p class="warn-text">修改报价将使已批准的预算失效，事项退回待审批。</p>' : ""}
    <div class="grid2">
      <label>报价金额<input name="amount" type="number" min="0" step="0.01" required value="${r.quote ? r.quote.amount : ""}"></label>
      <label>技师<input name="technician" required value="${r.quote ? escapeHtml(r.quote.technician) : ""}" placeholder="例如 王师傅"></label>
    </div>
    <label>报价说明<input name="note" value="${r.quote ? escapeHtml(r.quote.note) : ""}" placeholder="材料、工时等"></label>
    <div class="actions">
      <button class="primary" type="submit">${r.quote ? "提交新报价" : "提交报价"}</button>
      <button class="ghost" type="button" data-action="quote-cancel">取消</button>
    </div>
  </form>`;
}

function payForm(r, paid) {
  const approved = r.approval.amount;
  return `<form class="inline-form" id="pay-form" data-id="${r.id}">
    <p class="mini">已批预算 ¥${approved} · 已付 ¥${paid}${ui.simulateFail ? ' · <b class="pend">本次将模拟付款失败</b>' : ""}</p>
    <div class="grid2">
      <label>金额<input name="amount" type="number" min="0.01" step="0.01" required value="${Math.max(approved - paid, 0) || approved}"></label>
      <label>支付方式<select name="method">${payMethods.map((m) => `<option>${m}</option>`).join("")}</select></label>
    </div>
    <label>备注<input name="note" placeholder="例如 尾款"></label>
    <div class="actions">
      <button class="primary" type="submit">确认付款</button>
      <button class="ghost" type="button" data-action="pay-cancel">取消</button>
    </div>
  </form>`;
}

function progressForm(r) {
  return `<form class="inline-form" id="progress-form" data-id="${r.id}">
    <label>进度内容<input name="text" required placeholder="例如 已联系师傅，周三上门"></label>
    <div class="actions">
      <button class="primary" type="submit">保存进度${ui.online ? "" : "（离线，回网后按设备+批次合并）"}</button>
      <button class="ghost" type="button" data-action="progress-cancel">取消</button>
    </div>
  </form>`;
}

// ---------- 事件 ----------
app.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const v = view();
  const openOnly = (key) => {
    ui.editing = ui.quoting = ui.paying = ui.progressFor = null;
    ui[key] = id;
    render();
  };

  switch (action) {
    case "toggle-online":
      setOnline(!ui.online);
      break;
    case "sync-now":
      flushOutbox();
      render();
      break;
    case "rename-device": {
      const name = prompt("给这台设备起个名字（用于区分协作设备）", device.name);
      if (name && name.trim()) {
        device = renameDevice(name.trim());
        render();
      }
      break;
    }
    case "reset-demo":
      if (confirm("清空全部协作数据并恢复演示数据？")) {
        clearOutbox();
        writeLog(seedLog());
        ui.editing = ui.quoting = ui.paying = ui.progressFor = null;
        render();
      }
      break;
    case "filter":
      ui.filter = btn.dataset.filter;
      render();
      break;
    case "edit-open":
      openOnly("editing");
      break;
    case "quote-open":
      openOnly("quoting");
      break;
    case "pay-open":
      openOnly("paying");
      break;
    case "progress-open":
      openOnly("progressFor");
      break;
    case "edit-cancel":
      ui.editing = null;
      render();
      break;
    case "quote-cancel":
      ui.quoting = null;
      render();
      break;
    case "pay-cancel":
      ui.paying = null;
      render();
      break;
    case "progress-cancel":
      ui.progressFor = null;
      render();
      break;
    case "approve": {
      const r = findRepair(v, id);
      if (r && r.quote && r.approval.status === "pending") {
        commit({ type: "approval.approve", repairId: id, quoteRev: r.quote.rev, amount: r.quote.amount, by: device.name, at: Date.now() });
      }
      break;
    }
    case "retry-pay": {
      const p = v.payments.find((x) => x.attemptKey === btn.dataset.attempt);
      if (p && p.status === "failed" && ui.online) {
        // 重试沿用失败付款现场（同一 attemptKey），只更新原记录
        commit({
          type: "payment.retry",
          repairId: p.repairId,
          attemptKey: p.attemptKey,
          amount: p.amount,
          method: p.method,
          note: p.note,
          outcome: ui.simulateFail ? "failed" : "success",
          error: ui.simulateFail ? "支付网关超时（模拟）" : null,
          at: Date.now()
        });
      }
      break;
    }
    case "delete":
      if (confirm("删除该维修事项？其付款记录与待裁定冲突将一并移除。")) {
        commit({ type: "repair.delete", repairId: id, at: Date.now() });
      }
      break;
    case "conflict-keep":
    case "conflict-take":
      commit({
        type: "conflict.resolve",
        conflictId: btn.dataset.conflict,
        choice: action === "conflict-take" ? "take" : "keep",
        by: device.name,
        at: Date.now()
      });
      break;
  }
});

app.addEventListener("change", (event) => {
  const t = event.target;
  if (t.id === "role-select") {
    ui.role = t.value;
    localStorage.setItem("zfl14.role", t.value);
    render();
  } else if (t.id === "simulate-fail") {
    ui.simulateFail = t.checked;
    render();
  } else if (t.dataset.statusId) {
    const v = view();
    const r = findRepair(v, t.dataset.statusId);
    if (r && r.status !== t.value) {
      commit({ type: "repair.update", repairId: r.id, baseRev: r.rev, patch: { status: t.value }, at: Date.now() });
    }
  }
});

app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const v = view();

  if (form.id === "create-form") {
    commit({
      type: "repair.create",
      repair: {
        id: crypto.randomUUID(),
        location: data.location.trim(),
        title: data.title.trim(),
        priority: data.priority,
        cost: Number(data.cost || 0),
        status: data.status,
        photo: (data.photo || "").trim(),
        note: (data.note || "").trim()
      },
      at: Date.now()
    });
  } else if (form.id === "edit-form") {
    const r = findRepair(v, form.dataset.id);
    if (!r) return;
    const fields = {
      location: data.location.trim(),
      title: data.title.trim(),
      priority: data.priority,
      status: data.status,
      cost: Number(data.cost || 0),
      photo: (data.photo || "").trim(),
      note: (data.note || "").trim()
    };
    const patch = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val !== r[key]) patch[key] = val;
    }
    ui.editing = null;
    if (Object.keys(patch).length) {
      commit({ type: "repair.update", repairId: r.id, baseRev: r.rev, patch, at: Date.now() });
    } else {
      render();
    }
  } else if (form.id === "quote-form") {
    const r = findRepair(v, form.dataset.id);
    if (!r) return;
    ui.quoting = null;
    commit({
      type: "quote.submit",
      repairId: r.id,
      baseRev: r.rev,
      quote: { amount: Number(data.amount), technician: data.technician.trim(), note: (data.note || "").trim() },
      at: Date.now()
    });
  } else if (form.id === "pay-form") {
    const r = findRepair(v, form.dataset.id);
    if (!r || r.approval.status !== "approved" || !ui.online) return;
    ui.paying = null;
    commit({
      type: "payment.pay",
      repairId: r.id,
      attemptKey: crypto.randomUUID(),
      amount: Number(data.amount),
      method: data.method,
      note: (data.note || "").trim(),
      outcome: ui.simulateFail ? "failed" : "success",
      error: ui.simulateFail ? "支付网关超时（模拟）" : null,
      at: Date.now()
    });
  } else if (form.id === "progress-form") {
    const text = (data.text || "").trim();
    if (!text) return;
    ui.progressFor = null;
    commit({
      type: "progress.add",
      repairId: form.dataset.id,
      entry: { id: crypto.randomUUID(), text, at: Date.now() },
      at: Date.now()
    });
  }
});

// ---------- 工具 ----------
function filterRepairs(v, pendingConflicts) {
  switch (ui.filter) {
    case "todo":
    case "doing":
    case "done":
      return v.repairs.filter((r) => r.status === ui.filter);
    case "approving":
      return v.repairs.filter((r) => r.quote && r.approval.status === "pending");
    case "conflict":
      return v.repairs.filter((r) => pendingConflicts.some((c) => c.repairId === r.id));
    default:
      return v.repairs;
  }
}

function approvalBadge(r) {
  if (!r.quote) return "";
  const a = r.approval;
  if (a.status === "approved") return `<span class="badge ok">预算已批准 ¥${a.amount}</span>`;
  if (a.invalidated) return `<span class="badge warn">预算失效·待重审</span>`;
  return `<span class="badge warn">待审批</span>`;
}

function approvalText(r) {
  if (!r.quote) return "未报价";
  const a = r.approval;
  if (a.status === "approved") return "已批准";
  if (a.invalidated) return "预算失效·待重审";
  return "待审批";
}

function fmtField(field, val) {
  if (field === "status") return escapeHtml(statusLabels[val] || val);
  if (field === "priority") return escapeHtml(priorities[val] || val);
  if (field === "cost") return "¥" + Number(val || 0);
  if (field === "quote") {
    return val ? `¥${val.amount} · ${escapeHtml(val.technician)}${val.note ? " · " + escapeHtml(val.note) : ""}` : "（无报价）";
  }
  if (field === "photo") return val ? "已更新照片链接" : "（无照片）";
  return escapeHtml(String(val ?? "（空）"));
}

function options(map, selected) {
  return Object.entries(map)
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function fmtTime(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

render();

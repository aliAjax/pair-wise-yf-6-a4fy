// 界面渲染与事件绑定（纯渲染 + 回调 actions）
import {
  statuses,
  priorities,
  roles,
  roleAbilities
} from "./config.js";
import { budgetState } from "./store.js";

const h = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[ch]);

const money = (n) => `¥${Number(n || 0)}`;

const opLabels = { create: "新增", update: "修改" };

export function renderApp(state) {
  const device = state.devices.find((d) => d.id === state.currentDeviceId) || state.devices[0];
  const ability = roleAbilities[device.role];
  const pending = state.devices.reduce(
    (n, d) => n + (state.outboxes[d.id] || []).filter((e) => e.status === "pending").length,
    0
  );
  const conflictCount = state.conflicts.filter((c) => c.status === "pending").length;

  const counts = {
    pending_approval: state.repairs.filter((r) => r.status === "pending_approval").length,
    doing: state.repairs.filter((r) => r.status === "doing").length,
    done: state.repairs.filter((r) => r.status === "done").length,
    retry: Object.values(state.payments).filter((p) => p.status === "failed").length
  };

  return `
  <main class="shell">
    <header class="header">
      <div>
        <p class="eyebrow">家庭维修协作台 · 离线按设备号+批次合并 / 两版冲突户主裁定 / 报价联动预算 / 付款重试幂等</p>
        <h1>家庭维修事项</h1>
      </div>
      <section class="stats">
        <div class="stat"><span>待审批</span><strong>${counts.pending_approval}</strong></div>
        <div class="stat"><span>处理中</span><strong>${counts.doing}</strong></div>
        <div class="stat"><span>已完成</span><strong>${counts.done}</strong></div>
        <div class="stat ${counts.retry ? "stat-alert" : ""}"><span>待重试付款</span><strong>${counts.retry}</strong></div>
      </section>
    </header>

    <section class="device-bar panel">
      <div class="device-bar-row">
        <label class="device-select">当前设备
          <select id="device-select">
            ${state.devices
              .map(
                (d) =>
                  `<option value="${h(d.id)}" ${d.id === device.id ? "selected" : ""}>${h(d.name)} · ${h(roles[d.role])}</option>`
              )
              .join("")}
          </select>
        </label>
        <span class="role-badge role-${device.role}">${h(ability.label)}视角</span>
        <button class="net-toggle ${state.online ? "online" : "offline"}" id="net-toggle">
          ${state.online ? "● 在线" : "○ 离线"}
        </button>
        <label class="sim-fail">
          <input type="checkbox" id="simulate-fail" ${state.simulateFail ? "checked" : ""}>
          模拟付款失败
        </label>
        <button class="primary sync-btn" id="sync-btn" ${pending ? "" : "disabled"}>
          同步回网${pending ? `（${pending} 批待合并）` : ""}
        </button>
      </div>
      <div class="device-bar-meta">
        ${state.devices
          .map((d) => {
            const applied = (state.appliedBatches[d.id] || []).length;
            const pend = (state.outboxes[d.id] || []).filter((e) => e.status === "pending").length;
            return `<span class="device-meta">${h(d.name)}：已合并 ${applied} 批${pend ? ` · 待同步 ${pend}` : ""}</span>`;
          })
          .join("")}
      </div>
    </section>

    ${
      conflictCount
        ? `<section class="conflict-banner" id="conflict-banner">
             <strong>有 ${conflictCount} 项版本冲突待户主裁定</strong>
             <span>两台设备离线改了同一事项，已保留两版。</span>
             <button class="ghost" id="goto-conflict">去裁定</button>
           </section>`
        : ""
    }

    <section class="layout">
      <aside class="panel">
        <h2>新增维修事项</h2>
        <form class="form" id="repair-form">
          <label>位置<input name="location" required placeholder="例如卫生间"></label>
          <label>问题描述<textarea name="title" required placeholder="例如门锁松动"></textarea></label>
          <label>优先级<select name="priority">${renderPriorityOptions("medium")}</select></label>
          <label>报价 / 预计费用<input name="quoteAmount" type="number" min="0" step="1" value="0"></label>
          <label>处理状态<select name="status">${renderStatusOptions("pending_approval")}</select></label>
          <label>照片链接<input name="photo" type="url" placeholder="可选，粘贴图片地址"></label>
          <label>备注<textarea name="note" placeholder="师傅电话、材料或注意事项"></textarea></label>
          <button class="primary" type="submit">保存事项${state.online ? "" : "（离线，进入待同步）"}</button>
        </form>

        <div class="outbox">
          <h3>待同步批次 <small>（按设备号 + 批次序号合并）</small></h3>
          ${renderOutbox(state)}
          <p class="hint">玩法：切到「家人平板」断网改某事项，再切到「师傅手机」断网改同一事项，回网同步即触发冲突，由户主裁定。</p>
        </div>
      </aside>

      <section>
        <div class="toolbar">
          ${Object.entries({ all: "全部", ...statuses })
            .map(
              ([value, label]) =>
                `<button class="seg ${state.filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`
            )
            .join("")}
        </div>
        <div class="repairs">
          ${filteredRepairs(state).length
            ? filteredRepairs(state).map((r) => renderRepair(state, r, device, ability)).join("")
            : `<div class="empty">当前状态下没有维修事项</div>`}
        </div>
      </section>
    </section>

    ${renderModal(state)}
  </main>
  `;
}

function filteredRepairs(state) {
  if (state.filter === "all") return state.repairs;
  return state.repairs.filter((r) => r.status === state.filter);
}

function renderOutbox(state) {
  const groups = state.devices
    .map((d) => {
      const entries = (state.outboxes[d.id] || []).filter((e) => e.status === "pending");
      if (!entries.length) return "";
      return `
        <div class="outbox-group">
          <strong>${h(d.name)}</strong>
          ${entries
            .map((e) => {
              const repair = state.repairs.find((r) => r.id === e.repairId);
              const name = repair ? `${repair.location} · ${repair.title}` : "（新事项）";
              return `<div class="outbox-item">#${e.batchSeq} ${opLabels[e.op] || e.op} · ${h(name)}</div>`;
            })
            .join("")}
        </div>`;
    })
    .join("");
  return groups || `<p class="hint">暂无待同步批次</p>`;
}

function renderRepair(state, repair, device, ability) {
  const payment = state.payments[repair.id];
  const bs = budgetState(repair);
  const conflict = state.conflicts.find((c) => c.repairId === repair.id && c.status === "pending");

  return `
  <article class="repair ${conflict ? "repair-conflict" : ""}">
    <div class="photo">${repair.photo ? `<img src="${h(repair.photo)}" alt="${h(repair.location)}维修照片">` : "未添加照片"}</div>
    <div class="content">
      <div class="row">
        <h3>${h(repair.location)}</h3>
        <span class="priority ${repair.priority}">${priorities[repair.priority]}</span>
        <span class="status ${repair.status}">${statuses[repair.status]}</span>
        ${bs === "invalid" ? `<span class="badge badge-warn">预算已失效</span>` : ""}
        ${conflict ? `<span class="badge badge-conflict">版本冲突待裁定</span>` : ""}
      </div>
      <p>${h(repair.title)}</p>
      ${repair.note ? `<p class="note">${h(repair.note)}</p>` : ""}
      <div class="row cost-row">
        <span class="chip">报价 ${money(repair.quoteAmount)}</span>
        ${renderBudgetChip(ability, repair, bs)}
        ${renderPaymentChip(ability, payment)}
      </div>
      <div class="actions">
        <select data-status="${repair.id}">
          ${renderStatusOptions(repair.status)}
        </select>
        ${
          ability.changeQuote
            ? `<form class="inline-form" data-quote-form="${repair.id}">
                 <input name="quoteAmount" type="number" min="0" step="1" value="${Number(repair.quoteAmount) || 0}">
                 <button class="ghost" type="submit">改报价</button>
               </form>`
            : ""
        }
        ${
          ability.approve && bs !== "valid"
            ? `<button class="ghost" data-approve="${repair.id}" ${state.online ? "" : "disabled title=\"离线时不可批准预算\""}>${bs === "invalid" ? "重新批准预算" : "批准预算"}</button>`
            : ""
        }
        ${renderPaymentAction(state, ability, repair, payment)}
        <button class="ghost" data-edit="${repair.id}">编辑</button>
        ${device.role === "owner" ? `<button class="ghost danger" data-delete="${repair.id}">删除</button>` : ""}
      </div>
    </div>
  </article>
  `;
}

function renderBudgetChip(ability, repair, bs) {
  if (!ability.seeBudget) return `<span class="chip">预算 •••</span>`;
  if (bs === "none") return `<span class="chip muted">未批准预算</span>`;
  if (bs === "valid") return `<span class="chip ok">已批准预算 ${money(repair.approvedBudget)}</span>`;
  return `<span class="chip bad">预算失效 <s>${money(repair.approvedBudget)}</s> · 待重新批准</span>`;
}

function renderPaymentChip(ability, payment) {
  if (!payment) return `<span class="chip muted">未发起付款</span>`;
  const amount = ability.seePaymentAmount ? money(payment.amount) : "•••";
  if (payment.status === "paid") return `<span class="chip ok">已支付 ${amount}</span>`;
  if (payment.status === "pending") return `<span class="chip">待支付 ${amount}</span>`;
  return `<span class="chip bad">支付失败 ${amount} · 重试 ${payment.attempts} 次</span>`;
}

function renderPaymentAction(state, ability, repair, payment) {
  if (!ability.pay) return "";
  if (!state.online) return `<span class="chip muted">离线 · 回网后可付款</span>`;
  if (!payment) {
    return `<button class="ghost" data-pay="${repair.id}">发起付款</button>`;
  }
  if (payment.status === "failed") {
    return `<button class="ghost" data-retry="${repair.id}">重试付款（第 ${payment.attempts + 1} 次）</button>`;
  }
  if (payment.status === "pending") {
    return `<span class="chip">支付处理中…</span>`;
  }
  return "";
}

function renderStatusOptions(selected) {
  return Object.entries(statuses)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function renderPriorityOptions(selected) {
  return Object.entries(priorities)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function renderModal(state) {
  if (!state.ui || !state.ui.modal) return "";
  if (state.ui.modal === "edit") return renderEditModal(state);
  if (state.ui.modal === "conflict") return renderConflictModal(state);
  return "";
}

function renderEditModal(state) {
  const repair = state.repairs.find((r) => r.id === state.ui.repairId);
  if (!repair) return "";
  return `
  <div class="modal-mask" data-close-modal>
    <div class="modal" onclick="event.stopPropagation()">
      <h2>编辑维修事项</h2>
      <form class="form" id="edit-form" data-edit-form="${repair.id}">
        <label>位置<input name="location" required value="${h(repair.location)}"></label>
        <label>问题描述<textarea name="title" required>${h(repair.title)}</textarea></label>
        <label>优先级<select name="priority">${renderPriorityOptions(repair.priority)}</select></label>
        <label>报价 / 预计费用<input name="quoteAmount" type="number" min="0" step="1" value="${Number(repair.quoteAmount) || 0}"></label>
        <label>处理状态<select name="status">${renderStatusOptions(repair.status)}</select></label>
        <label>照片链接<input name="photo" type="url" value="${h(repair.photo || "")}"></label>
        <label>备注<textarea name="note">${h(repair.note || "")}</textarea></label>
        <div class="modal-actions">
          <button class="ghost" type="button" data-close-modal>取消</button>
          <button class="primary" type="submit">保存修改${state.online ? "" : "（离线，进入待同步）"}</button>
        </div>
      </form>
    </div>
  </div>
  `;
}

function renderConflictModal(state) {
  const conflict = state.conflicts.find((c) => c.id === state.ui.conflictId);
  if (!conflict) return "";
  const [a, b] = conflict.versions;
  const fields = [
    ["位置", (s) => s.location],
    ["问题描述", (s) => s.title],
    ["状态", (s) => statuses[s.status]],
    ["报价", (s) => money(s.quoteAmount)],
    ["批准预算", (s) => (s.approvedBudget == null ? "未批准" : money(s.approvedBudget))],
    ["备注", (s) => s.note || "—"]
  ];
  const diffRows = fields
    .map(([label, get]) => {
      const va = get(a.snapshot);
      const vb = get(b.snapshot);
      const diff = String(va) !== String(vb);
      return `
        <div class="diff-row ${diff ? "diff-changed" : ""}">
          <span class="diff-label">${label}</span>
          <span class="diff-a">${h(va)}</span>
          <span class="diff-b">${h(vb)}</span>
        </div>`;
    })
    .join("");

  return `
  <div class="modal-mask" data-close-modal>
    <div class="modal modal-wide" onclick="event.stopPropagation()">
      <h2>版本冲突 · 等户主裁定</h2>
      <p class="hint">两台设备离线修改了同一事项，以下两版均已保留。请户主选择采用哪一版，另一版丢弃。</p>
      <div class="diff-grid">
        <div class="diff-col">
          <h3>A 版 · 当前共享版 <span class="chip">${h(a.deviceName)}</span></h3>
        </div>
        <div class="diff-col">
          <h3>B 版 · 离线提交版 <span class="chip">${h(b.deviceName)}</span></h3>
        </div>
      </div>
      <div class="diff-rows">${diffRows}</div>
      <div class="modal-actions">
        <button class="ghost" data-close-modal>稍后</button>
        <button class="ghost" data-resolve="${conflict.id}" data-choice="0">采用 A 版（保持当前）</button>
        <button class="primary" data-resolve="${conflict.id}" data-choice="1">采用 B 版（离线版）</button>
      </div>
    </div>
  </div>
  `;
}

// 事件绑定：actions 由 main.js 提供
export function bindEvents(state, actions) {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  $("#device-select").addEventListener("change", (e) => actions.setDevice(e.target.value));
  $("#net-toggle").addEventListener("click", () => actions.toggleOnline());
  $("#sync-btn").addEventListener("click", () => actions.sync());
  $("#simulate-fail").addEventListener("change", (e) => actions.setSimulateFail(e.target.checked));

  const goto = $("#goto-conflict");
  if (goto) goto.addEventListener("click", () => actions.openConflict());

  $("#repair-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    actions.saveNew({
      location: data.location.trim(),
      title: data.title.trim(),
      priority: data.priority,
      quoteAmount: Number(data.quoteAmount || 0),
      status: data.status,
      photo: (data.photo || "").trim(),
      note: data.note.trim()
    });
    e.target.reset();
  });

  $$("[data-filter]").forEach((btn) => btn.addEventListener("click", () => actions.setFilter(btn.dataset.filter)));

  $$("[data-status]").forEach((sel) =>
    sel.addEventListener("change", () => actions.saveField(sel.dataset.status, { status: sel.value }))
  );

  $$("[data-quote-form]").forEach((form) =>
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.querySelector("[name=quoteAmount]");
      actions.saveField(form.dataset.quoteForm, { quoteAmount: Number(input.value || 0) });
    })
  );

  $$("[data-approve]").forEach((btn) =>
    btn.addEventListener("click", () => actions.approveBudget(btn.dataset.approve))
  );

  $$("[data-pay]").forEach((btn) =>
    btn.addEventListener("click", () => actions.createPayment(btn.dataset.pay))
  );

  $$("[data-retry]").forEach((btn) =>
    btn.addEventListener("click", () => actions.retryPayment(btn.dataset.retry))
  );

  $$("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => actions.openEdit(btn.dataset.edit))
  );

  $$("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => actions.deleteRepair(btn.dataset.delete))
  );

  // 弹窗
  $$("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", () => actions.closeModal())
  );
  $$("[data-resolve]").forEach((btn) =>
    btn.addEventListener("click", () => actions.resolveConflict(btn.dataset.resolve, Number(btn.dataset.choice)))
  );

  const editForm = $("#edit-form");
  if (editForm) {
    editForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      actions.saveEdit({
        location: data.location.trim(),
        title: data.title.trim(),
        priority: data.priority,
        quoteAmount: Number(data.quoteAmount || 0),
        status: data.status,
        photo: (data.photo || "").trim(),
        note: data.note.trim()
      });
    });
  }
}

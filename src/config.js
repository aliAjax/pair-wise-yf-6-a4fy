// 全局配置：状态、角色、设备、付款方式与存储键

export const STORAGE_KEY = "zfl-14-home-repair-collab-v2";

// 维修事项状态：待审批 -> 已批准 -> 处理中 -> 已完成
export const statuses = {
  pending_approval: "待审批",
  approved: "已批准",
  doing: "处理中",
  done: "已完成"
};

export const statusOrder = ["pending_approval", "approved", "doing", "done"];

export const priorities = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

// 家庭成员角色
export const roles = {
  owner: "户主",
  family: "家人",
  master: "师傅"
};

// 各角色可见 / 可操作的能力（费用明细按角色显示）
export const roleAbilities = {
  owner: {
    label: "户主",
    seeQuote: true,
    seeBudget: true,
    seePaymentAmount: true,
    seePaymentStatus: true,
    approve: true,
    adjudicate: true,
    changeQuote: true,
    pay: true,
    edit: true
  },
  family: {
    label: "家人",
    seeQuote: true,
    seeBudget: false,
    seePaymentAmount: false,
    seePaymentStatus: true,
    approve: false,
    adjudicate: false,
    changeQuote: false,
    pay: false,
    edit: true
  },
  master: {
    label: "师傅",
    seeQuote: true,
    seeBudget: false,
    seePaymentAmount: false,
    seePaymentStatus: true,
    approve: false,
    adjudicate: false,
    changeQuote: true,
    pay: false,
    edit: true
  }
};

// 模拟的多台设备（同一浏览器里切换，用于演示离线合并与冲突）
export const defaultDevices = [
  { id: "d-owner", name: "户主手机", role: "owner" },
  { id: "d-family", name: "家人平板", role: "family" },
  { id: "d-master", name: "师傅手机", role: "master" }
];

export const paymentMethods = {
  cash: "现金",
  wechat: "微信",
  alipay: "支付宝",
  bank: "银行卡"
};

export const paymentStatuses = {
  pending: "待支付",
  paid: "已支付",
  failed: "支付失败"
};

/**
 * @file toast.ts
 * @description 全局 Toast 派发唯一入口：经 window 上的 app-toast CustomEvent 由
 *              components/ui/Toast 宿主（挂载于 App 根部）消费。视图/组件/store 一律
 *              调用本函数，禁止各自内联 dispatchEvent（避免文案前缀与事件名漂移）。
 *              消息前缀决定配色：✅ 成功 / ❌ 失败 / ⚠️ 告警 / 📧 邮件 / 🛑 拦截。
 * @layer Utils (中立基础设施叶子)
 * @storage_impact 无存储读写；纯事件派发。
 * @author 开发团队
 */

/**
 * 弹出全局 Toast 提示。
 *
 * @param {string} message - 提示文案（建议带语义前缀以命中配色）
 */
export function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));
}

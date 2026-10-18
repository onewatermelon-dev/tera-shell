/**
 * 用量文案的小工具。
 *
 * 独立成模块是因为价格展示已撤掉（2026-10-18）：原来这些函数在
 * modelPricing.ts 里，现在只剩纯格式化，别再让"成本"字眼误导后来人。
 */

/** token 数千分位（1,234）。 */
export function formatTokens(
  count: number
): string {
  return count.toLocaleString("en-US");
}

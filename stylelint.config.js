/**
 * Stylelint 配置文件
 * 项目样式：SCSS（src/styles/app.scss）+ Vue SFC 内联 <style lang="scss">
 */
export default {
  extends: [
    "stylelint-config-standard", // 标准规则（基础 CSS）
    "stylelint-config-standard-scss", // 标准 SCSS 规则（含 recommended-scss）
    "stylelint-config-recommended-vue/scss", // Vue SFC <style> 支持（postcss-html 解析）
    "stylelint-config-recess-order" // 属性顺序（布局 → 盒模型 → 视觉 → 排版）
  ],
  rules: {
    // 自定义规则
    "selector-class-pattern": null, // 不限制类名格式（项目已有 kebab-case 命名，无需强制）
    "no-descending-specificity": null // 关闭选择器优先级递减检查（终端主题类样式常互相覆盖）
  },
  ignoreFiles: ["**/node_modules/**", "**/dist/**", "**/src-tauri/**", "src/auto-imports.d.ts", "src/components.d.ts"]
};

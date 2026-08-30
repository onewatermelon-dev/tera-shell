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
  plugins: ["@stylistic/stylelint-plugin"], // 格式化规则（缩进、分号等，stylelint 16 起从核心移至社区插件）
  rules: {
    // 格式化规则（stylelint 16 起从核心移至 @stylistic 社区插件）
    "@stylistic/indentation": 2, // 缩进 2 空格
    "@stylistic/declaration-block-trailing-semicolon": "always", // 声明结尾必须有分号
    // 通用规则
    "function-url-quotes": "always", // URL 必须加引号
    "color-hex-length": "long", // 16 进制颜色用扩写形式（#ffffff 而非 #fff）
    "rule-empty-line-before": "always-multi-line", // 多行规则之前必须有空行（原配置为 never，会删光所有空行，不建议）
    "font-family-no-missing-generic-family-keyword": null, // 不强制通用字体族关键字（如 sans-serif）
    "property-no-unknown": null, // 不校验未知属性（兼容实验性 CSS 属性）
    "no-empty-source": null, // 允许空样式源（如空 <style> 块）
    "value-no-vendor-prefix": null, // 允许浏览器前缀（多行省略 -webkit-box 等需要）
    "selector-class-pattern": null, // 不限制类名格式（项目已有 kebab-case 命名，无需强制）
    "no-descending-specificity": null, // 关闭选择器优先级递减检查（终端主题类样式常互相覆盖）
    "selector-pseudo-class-no-unknown": [
      // 允许 Vue 深度选择器等伪类
      true,
      {
        ignorePseudoClasses: ["global", "v-deep", "deep", "slotted"]
      }
    ]
  },
  ignoreFiles: ["**/node_modules/**", "**/dist/**", "**/src-tauri/**", "src/auto-imports.d.ts", "src/components.d.ts"]
};

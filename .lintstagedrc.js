/**
 * 配置对象，用于定义不同文件类型需要执行的处理命令
 * 该导出对象是项目构建或代码检查工具的配置，例如在ESLint、Prettier等工具中使用
 */
export default {
  "*.{js,ts,cjs,json,tsx,css,less,scss,vue,html,md}": ["cspell lint"],
  "*.{js,ts,vue,md}": ["prettier --write", "eslint"],
  "*.{css,scss,vue}": ["stylelint --fix"]
};

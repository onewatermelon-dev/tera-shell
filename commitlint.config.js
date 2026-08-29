export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-leading-blank": [2, "always"],
    "footer-leading-blank": [1, "always"],
    "header-max-length": [2, "always", 108],
    "subject-empty": [2, "never"],
    "type-empty": [2, "never"],
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"]
    ]
  },
  prompt: {
    types: [
      { value: "feat", name: "✨ feat: 新增功能" },
      { value: "fix", name: "🐛 fix: 修复bug" },
      { value: "docs", name: "📝 docs: 文档" },
      { value: "style", name: "💄 style: 代码格式(不影响代码运行的变动)" },
      { value: "refactor", name: "♻️ refactor: 重构(即不是新增功能，也不是修改bug的代码变动)" },
      { value: "perf", name: "⚡️ perf: 改善性能的代码更改" },
      { value: "test", name: "✅ test: 添加或修改测试" },
      { value: "build", name: "🔧 build: 影响构建系统或外部依赖的更改(例如:gulp，npm，webpack)" },
      { value: "ci", name: "👷 ci: 更改我们的持续集成文件和脚本(以上内容除外)" },
      { value: "chore", name: "🔨 chore: 其他改变(不包括上述类型)" },
      { value: "revert", name: "⏪️ revert: 回滚到上一个版本" }
    ],
    scopes: ["root", "components", "utils", "cli", "backend", "frontend"],
    allowCustomScopes: true,
    skipQuestions: ["body", "footerPrefix", "footer", "breaking"],
    messages: {
      type: "🎯 请选择提交类型:",
      scope: "📌 请选择一个提交范围(可选):",
      customScope: "🔧 请输入自定义的提交范围:",
      subject: "📝 请简要描述提交(必填):",
      body: "📖 请输入详细描述(可选):",
      breaking: "💥 请描述破坏性变更(可选):",
      footerPrefix: "🏷️  请输入破坏性变更的ISSUE编号(可选):",
      confirmCommit: "✅ 确认使用以上提交信息?"
    }
  }
};

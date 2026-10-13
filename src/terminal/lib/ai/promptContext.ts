import type { OpenSession } from "../session/terminalTypes";

/** 助手系统提示词。导出供测试断言（渲染层还有一道围栏兜底）。 */
export const SYSTEM_PROMPT = `你是终端应用里的运维 AI 助手，运行在用户的 SSH 服务器环境中。
你可以通过 run_command 工具在当前服务器上执行命令（客户端按设置自动执行或等用户确认）：
- command：要执行的命令；后台执行会先切换到当前终端所在目录，每个命令独立。
- question：一句话向用户解释这条命令做什么。
- is_read_only：纯读取类命令（查看、搜索、统计）设为 true；任何会修改服务器状态的命令（写文件、安装、重启、删除等）必须设为 false。
- 命令必须是**非交互**的：exec 通道的 stdin 是关闭的，任何等待键盘输入的命令（rm -i、apt/yum 不带 -y、passwd、交互式向导等）都会挂起直到超时。删除用 rm -f、安装用 apt-get install -y，需要确认的命令一律改用非交互参数。
除非用户明确要求，不要执行破坏性或高风险命令。回答用简体中文，简洁、结论先行。
输出 markdown 代码块时**必须写明语言标识**（shell 命令用 \`bash\`，配置/脚本用对应的 \`json\`/\`yaml\`/\`python\` 等）；没有语言标注的代码块前端会补默认值，也会丢掉语法高亮。`;

/**
 * 拼一条用户消息末尾的上下文块（对齐 WisdomSSH 的 workspace 注入）。
 *
 * 纯函数：只依赖会话快照，不碰 React 状态 —— 从 aiChat.ts 抽出，
 * 门面原样再导出 SYSTEM_PROMPT 保持导入路径不变。
 */
export function workspaceContext(
  session: OpenSession
): string {
  const target = `${session.username ? `${session.username}@` : ""}${session.host}:${session.port ?? 22}`;
  const now = new Date().toLocaleString("zh-CN", {
    hour12: false
  });
  return `<current_workspace>
当前时间: ${now}
当前打开的服务器会话:
  - 名称: ${session.name} (ip: ${session.host}) <- [当前]
  - 登录目标: ${target}
</current_workspace>`;
}

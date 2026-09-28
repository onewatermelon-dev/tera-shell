/**
 * 快捷命令解释：终端里输入「命令/?」回车后，把命令交给当前选中的
 * AI 模型解释（用途 / 参数 / 示例），流式文本回调给终端渲染。
 */
import {
  listOpenAiModels,
  loadSelectedModel,
  streamChatCompletion,
  type ProtocolMessage
} from "@/terminal/lib/aiChat";

/** 解释输出的固定结构，与参考实现（WisdomSSH）一致。 */
const EXPLAIN_SYSTEM = `你是终端里的命令解释助手。用户给你一条 shell 命令，请按以下结构用中文简洁解释：
1. 命令基本用途（一句话）
2. 各参数含义和作用（逐行「-x：说明」，命令无参数时本节写「无」）
3. 常见使用示例（2~3 行，每行命令 + 「# 注释」）
4. 潜在风险或注意事项（如误删、覆盖、权限、性能影响；没有时本节写「无」）
5. 相关替代命令（1~3 个同类命令及一句话差异；没有时本节写「无」）
五节必须全部输出、序号固定为 1 到 5，不得跳号；每节以「N. 标题」单独一行开头；直接输出内容，不要寒暄，不要用 markdown 代码块。`;

/**
 * 请求模型解释命令；onText 收到的是正文增量（不含思考内容）。
 * 未配置可用模型时抛错，由调用方落到终端提示。
 */
export async function explainCommand(
  command: string,
  onText: (chunk: string) => void
): Promise<void> {
  const models = listOpenAiModels();
  const selectedKey = loadSelectedModel();
  const option =
    models.find(
      m =>
        `${m.providerId}::${m.modelId}` ===
        selectedKey
    ) ?? models[0];
  if (!option) {
    throw new Error(
      "未配置模型，请先在「设置 - 模型供应商」添加并启用"
    );
  }
  const messages: ProtocolMessage[] = [
    { role: "system", content: EXPLAIN_SYSTEM },
    {
      role: "user",
      content: `请解释这条命令：\n${command}`
    }
  ];
  let streamed = false;
  const result = await streamChatCompletion(
    option,
    messages,
    chunk => {
      if (!chunk.content) return;
      streamed = true;
      onText(chunk.content);
    },
    // 纯文本解释请求：不带工具，防模型回 tool_call 导致无正文
    false
  );
  // 模型不支持流式时 onDelta 全程为空：一次性补全正文
  if (!streamed && result.content) {
    onText(result.content);
    return;
  }
  if (!streamed && !result.content)
    onText("（模型未返回解释内容）");
}

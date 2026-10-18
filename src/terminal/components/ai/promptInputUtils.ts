/** 单张图上限：base64 进请求体，超大图直接拒收。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 在已发送问题间移动，并在越过最新一条时恢复未发送草稿。 */
export function stepPromptHistory(
  history: string[],
  current: number | null,
  draft: string,
  direction: "up" | "down"
): { index: number | null; value: string } {
  const next =
    direction === "up"
      ? Math.max(
          0,
          (current ?? history.length) - 1
        )
      : (current ?? history.length - 1) + 1;
  return next >= history.length
    ? { index: null, value: draft }
    : { index: next, value: history[next] ?? "" };
}

/** 文件 → data URL；非图片或超限返回 null。 */
export async function fileToDataUrl(
  file: File
): Promise<string | null> {
  if (
    !file.type.startsWith("image/") ||
    file.size > MAX_IMAGE_BYTES
  ) {
    console.warn(
      "[ai-image] 跳过不支持的文件",
      file.name,
      file.type,
      file.size
    );
    return null;
  }
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result));
    reader.onerror = () => {
      console.warn(
        "[ai-image] 读取失败",
        file.name
      );
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

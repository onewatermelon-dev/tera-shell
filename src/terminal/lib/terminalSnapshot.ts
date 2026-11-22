/**
 * 终端选区 → Carbon 风格图片 → 剪贴板。
 *
 * 右键菜单「复制为图片」的底层实现：把选区纯文本渲染到离屏 canvas
 * （深色窗口卡片 + 渐变底），导出 PNG 写进剪贴板。发文档 / 博客 / 聊天
 * 时比裸文本好看得多。
 *
 * 主题色走固定深色盘，不随应用主题 —— 出图是拿去分享的，风格恒定才有
 * 辨识度（Carbon/Silicon 的做法）。
 */

/** 测量上限：行数超出截断（全选整个缓冲区的防御），列宽同理。 */
const MAX_ROWS = 500;
const MAX_COLS = 200;

/** 截断标记的展示文案。 */
const TRUNCATE_NOTE = "…… 已截断";

type SnapshotMeasure = {
  /** 渲染行（含截断标记行，若有） */
  lines: string[];
  /** 最长行字符数（等宽字体下即像素宽度系数） */
  cols: number;
  /** 是否发生了截断 */
  truncated: boolean;
};

/**
 * 纯测量：把选区文本整理成待渲染的行，算出列数与是否截断。
 *
 * Tab 统一展开成 4 空格（等宽测量/绘制才对齐），\r\n 归一成 \n。
 * 单独拆出来是为了能进 vitest（纯函数，不碰 DOM）。
 */
export function measureSnapshot(
  text: string
): SnapshotMeasure {
  const source = text
    .replace(/\t/g, "    ")
    .replace(/\r\n?/g, "\n");
  const rawLines = source.split("\n");
  const truncated = rawLines.length > MAX_ROWS;
  const lines = truncated
    ? rawLines
        .slice(0, MAX_ROWS)
        .concat(TRUNCATE_NOTE)
    : rawLines;
  // 末行若恰好在截断点前是空行，去掉它免得多一张空白行
  while (lines.length > 1 && lines.at(-1) === "")
    lines.pop();
  const cols = Math.min(
    MAX_COLS,
    lines.reduce(
      (max, line) => Math.max(max, line.length),
      0
    )
  );
  return { lines, cols, truncated };
}

/**
 * 把选区渲染成 PNG 图片并写入剪贴板。
 *
 * 布局：渐变底 + 阴影卡片（标题栏三点 + 等宽字体正文），2x 缩放导出
 * 保证高清。失败（渲染/写剪贴板）向上抛，由菜单的 onError 统一提示。
 */
export async function copySelectionAsImage(
  text: string
): Promise<void> {
  if (!text.trim()) throw new Error("选区为空");
  const blob = await renderSelectionImage(text);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob })
  ]);
}

/** 渲染选区文本为 PNG Blob。参数与调色盘见 {@link measureSnapshot}。 */
async function renderSelectionImage(
  text: string
): Promise<Blob> {
  const { lines, cols, truncated } =
    measureSnapshot(text);

  // —— 布局常量（逻辑像素，导出统一乘 2 倍缩放）——
  const scale = 2;
  const fontSize = 13;
  const font = `${fontSize}px "Cascadia Mono", Consolas, monospace`;
  const lineH = 20;
  const codePadX = 20;
  const codePadY = 16;
  const titleH = 40;
  const outerPad = 48;
  const cardRadius = 12;

  // 等宽字体字符宽：用真实 canvas 量，不同系统字体微差不影响排版
  const probe = document.createElement("canvas");
  const probeCtx = probe.getContext("2d")!;
  probeCtx.font = font;
  const charW = probeCtx.measureText("M").width;

  const codeW = Math.max(
    cols * charW + codePadX * 2,
    380
  );
  const codeH =
    codePadY + lines.length * lineH + codePadY;
  const cardW = codeW;
  const cardH = titleH + codeH;
  const width = cardW + outerPad * 2;
  const height = cardH + outerPad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  // 渐变底
  const bg = ctx.createLinearGradient(
    0,
    0,
    width,
    height
  );
  bg.addColorStop(0, "#667eea");
  bg.addColorStop(1, "#764ba2");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // 卡片 + 投影
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  roundRect(
    ctx,
    outerPad,
    outerPad,
    cardW,
    cardH,
    cardRadius
  );
  ctx.fillStyle = "#0d1117";
  ctx.fill();
  ctx.shadowColor = "transparent";

  // 标题栏：三点 + 标题文字
  const top = outerPad;
  const dotY = top + titleH / 2;
  const dotR = 6;
  const dots = ["#ff5f57", "#febc2e", "#28c840"];
  dots.forEach((color, index) => {
    ctx.beginPath();
    ctx.arc(
      outerPad + 18 + index * 18,
      dotY,
      dotR,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = color;
    ctx.fill();
  });
  ctx.font = `12px "Segoe UI", sans-serif`;
  ctx.fillStyle = "#8b949e";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(
    "Tera Shell",
    outerPad + cardW / 2,
    dotY
  );
  ctx.textAlign = "left";
  // 标题栏分隔线
  ctx.fillStyle = "#21262d";
  ctx.fillRect(outerPad, top + titleH, cardW, 1);

  // 正文：逐行等宽绘制
  ctx.font = font;
  ctx.fillStyle = "#e6edf3";
  ctx.textBaseline = "top";
  const codeTop = top + titleH;
  lines.forEach((line, index) => {
    ctx.fillText(
      line,
      outerPad + codePadX,
      codeTop + codePadY + index * lineH + 3
    );
  });
  if (truncated) {
    // 截断提示行用弱色，与正文区分
    ctx.fillStyle = "#8b949e";
    ctx.fillText(
      lines.at(-1)!,
      outerPad + codePadX,
      codeTop +
        codePadY +
        (lines.length - 1) * lineH +
        3
    );
  }

  const blob = await new Promise<Blob>(
    (resolve, reject) =>
      canvas.toBlob(
        value =>
          value
            ? resolve(value)
            : reject(new Error("PNG 导出失败")),
        "image/png"
      )
  );
  return blob;
}

/** 圆角矩形路径（canvas 没有内置圆角 rect）。 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

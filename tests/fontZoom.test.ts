import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { attachFontZoom } from "@/terminal/lib/fontZoom";

/**
 * 最小宿主：只提供事件能力，不提供 ownerDocument。
 *
 * 提示浮层因此被跳过（fontZoom 在没有 DOM 时静默不带提示），
 * 正好把测试聚焦在「手势 → 字号」这一层。
 */
function createHost(): HTMLElement {
  return new EventTarget() as unknown as HTMLElement;
}

/** 造滚轮事件：node 环境没有 WheelEvent，手工挂上需要的字段。 */
function wheelEvent(
  deltaY: number,
  {
    ctrlKey = true,
    deltaMode = 0
  }: {
    ctrlKey?: boolean;
    deltaMode?: number;
  } = {}
): WheelEvent {
  const event = new Event("wheel", {
    cancelable: true
  });
  Object.assign(event, {
    deltaY,
    deltaMode,
    ctrlKey
  });
  return event as unknown as WheelEvent;
}

/** 搭一套「宿主 + 缩放器」，附调用记录与派发事件的便捷方法。 */
function setup(fontSize = 14) {
  let current = fontSize;
  const applied: number[] = [];
  const host = createHost();
  const detach = attachFontZoom({
    host,
    getFontSize: () => current,
    applyFontSize: size => {
      current = size;
      applied.push(size);
    },
    formatHint: size => `字号 ${size} px`
  });
  return {
    applied,
    detach,
    get current() {
      return current;
    },
    zoom(
      deltaY: number,
      options?: {
        ctrlKey?: boolean;
        deltaMode?: number;
      }
    ) {
      const event = wheelEvent(deltaY, options);
      host.dispatchEvent(event);
      return event;
    }
  };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(
    () => {}
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ctrl + 滚轮缩放字号", () => {
  it("不按 Ctrl 时不改字号，也不拦截滚轮", () => {
    const zoom = setup();
    const event = zoom.zoom(-100, {
      ctrlKey: false
    });
    expect(zoom.applied).toEqual([]);
    expect(zoom.current).toBe(14);
    // 事件必须继续传给 xterm，让终端正常回滚
    expect(event.defaultPrevented).toBe(false);
  });

  it("Ctrl + 上滚放大、下滚缩小", () => {
    const zoom = setup();
    const up = zoom.zoom(-100);
    expect(zoom.current).toBe(15);
    expect(up.defaultPrevented).toBe(true);
    zoom.zoom(100);
    expect(zoom.current).toBe(14);
  });

  it("位移不足一档时先累积，够了才走一档", () => {
    const zoom = setup();
    zoom.zoom(-30);
    expect(zoom.applied).toEqual([]);
    zoom.zoom(-20);
    expect(zoom.current).toBe(15);
    // 触发后计数清零：继续同方向滚要重新累积
    zoom.zoom(-20);
    expect(zoom.applied).toEqual([15]);
  });

  it("deltaMode 为「行」时按行换算，一次即一档", () => {
    const zoom = setup();
    zoom.zoom(-3, { deltaMode: 1 });
    expect(zoom.current).toBe(15);
  });

  it("到达字号上下限后不再写设置", () => {
    const top = setup(24);
    top.zoom(-100);
    expect(top.applied).toEqual([]);
    expect(top.current).toBe(24);

    const bottom = setup(10);
    bottom.zoom(100);
    expect(bottom.applied).toEqual([]);
    expect(bottom.current).toBe(10);
  });

  it("解绑后不再响应滚轮", () => {
    const zoom = setup();
    zoom.detach();
    expect(zoom.zoom(-100).defaultPrevented).toBe(
      false
    );
    expect(zoom.applied).toEqual([]);
  });
});

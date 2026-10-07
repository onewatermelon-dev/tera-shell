import { describe, expect, it } from "vitest";
import {
  attrToGroupId,
  COLOR_TAGS,
  colorHex,
  groupSessions,
  isCustomColor,
  normalizeColorTag,
  parseGroups,
  UNGROUPED_ATTR,
  UNGROUPED_ID,
  type SessionGroup,
  type SessionGroupView
} from "@/sessions/lib/sessionGroup";
import type { SavedSession } from "@/sessions/lib/session";

/** 取某一节里的会话 id，按数组顺序。 */
function ids(view: SessionGroupView): string[] {
  return view.sessions.map(s => s.id);
}

/** 造一条会话：只关心分组/颜色，连接信息留最小集。 */
function session(
  id: string,
  groupId = ""
): SavedSession {
  return {
    id,
    name: id,
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "root",
    groupId,
    color: ""
  };
}

function group(
  id: string,
  patch: Partial<SessionGroup> = {}
): SessionGroup {
  return {
    id,
    name: id,
    color: "",
    collapsed: false,
    ...patch
  };
}

describe("groupSessions 分组聚合", () => {
  it("按groups 顺序出节，组内保持会话数组原序", () => {
    const views = groupSessions(
      [
        session("b1", "g2"),
        session("a1", "g1"),
        session("b2", "g2"),
        session("a2", "g1")
      ],
      [
        group("g1", { name: "生产" }),
        group("g2", { name: "测试" })
      ]
    );
    expect(views.map(v => v.name)).toEqual([
      "生产",
      "测试"
    ]);
    expect(ids(views[0]!)).toEqual(["a1", "a2"]);
    expect(ids(views[1]!)).toEqual(["b1", "b2"]);
  });

  it("无分组的会话并入末尾的「未分组」节", () => {
    const views = groupSessions(
      [session("a1", "g1"), session("free")],
      [group("g1")]
    );
    expect(views).toHaveLength(2);
    const last = views[1]!;
    expect(last.builtin).toBe(true);
    expect(last.id).toBe("");
    expect(ids(last)).toEqual(["free"]);
  });

  it("指向已删除分组的会话回落未分组，不消失", () => {
    const views = groupSessions(
      [
        session("orphan", "gone"),
        session("a1", "g1")
      ],
      [group("g1")]
    );
    expect(views).toHaveLength(2);
    expect(views[1]!.builtin).toBe(true);
    expect(ids(views[1]!)).toEqual(["orphan"]);
  });

  it("空分组仍然渲染 —— 那是刚建好还没放东西的位置", () => {
    const views = groupSessions(
      [session("a1", "g1")],
      [group("g1"), group("empty")]
    );
    expect(views).toHaveLength(2);
    expect(views[1]!.sessions).toEqual([]);
    expect(views[1]!.builtin).toBe(false);
  });

  it("全都没有分组时不出空壳，只有一节未分组", () => {
    const views = groupSessions(
      [session("a"), session("b")],
      []
    );
    expect(views).toHaveLength(1);
    expect(views[0]!.builtin).toBe(true);
  });

  it("会话为空且无分组时返回空数组（侧栏据此显示「无匹配」）", () => {
    expect(groupSessions([], [])).toEqual([]);
  });

  it("分组名为纯空白时显示占位符，不留空标题", () => {
    const views = groupSessions(
      [],
      [group("g1", { name: "   " })]
    );
    expect(views[0]!.name).toBe("—");
  });

  it("折叠态与 builtin 标记原样透传", () => {
    const views = groupSessions(
      [session("a1", "g1")],
      [group("g1", { collapsed: true })]
    );
    expect(views[0]!.collapsed).toBe(true);
    expect(views[0]!.builtin).toBe(false);
  });
});

describe("parseGroups 容错", () => {
  it("空值 / 非法 JSON / 非数组一律按空处理", () => {
    expect(parseGroups(null)).toEqual([]);
    expect(parseGroups("{oops")).toEqual([]);
    expect(parseGroups('{"a":1}')).toEqual([]);
  });

  it("字段缺失与脏类型被夹成合法值", () => {
    const parsed = parseGroups(
      JSON.stringify([
        { id: "g1" },
        {
          id: "g2",
          name: 123,
          color: "not-a-color",
          collapsed: "yes"
        }
      ])
    );
    expect(parsed[0]).toEqual({
      id: "g1",
      name: "",
      color: "",
      collapsed: false
    });
    // collapsed 只认 true；其余真值不算折叠
    expect(parsed[1]!.collapsed).toBe(false);
    expect(parsed[1]!.name).toBe("123");
    expect(parsed[1]!.color).toBe("");
  });
});

describe("颜色标记", () => {
  it("normalizeColorTag 拒绝未登记取值", () => {
    expect(normalizeColorTag("red")).toBe("red");
    expect(normalizeColorTag("chartreuse")).toBe(
      ""
    );
    expect(normalizeColorTag(undefined)).toBe("");
    expect(normalizeColorTag(7)).toBe("");
  });

  it("colorHex 对空/未知返回透明，不抛错", () => {
    expect(colorHex("")).toBe("transparent");
    expect(colorHex(undefined)).toBe(
      "transparent"
    );
    expect(colorHex("nope" as never)).toBe(
      "transparent"
    );
  });

  it("colorHex 取到色板里的实际色值", () => {
    expect(colorHex("red")).toMatch(
      /^#[0-9a-f]{6}$/i
    );
  });
});

describe("拖拽落点的分组标记", () => {
  it("占位符翻回未分组（空串），不会变成真分组 id", () => {
    // 回归测试：曾用字面量 "ungrouped" 当 data-group-section 的值，
    // 拖到未分组节就等于凭空建了个叫 ungrouped 的分组
    expect(attrToGroupId(UNGROUPED_ATTR)).toBe(
      UNGROUPED_ID
    );
    expect(attrToGroupId(UNGROUPED_ATTR)).toBe(
      ""
    );
  });

  it("真实分组 id 原样透传", () => {
    expect(attrToGroupId("g-123")).toBe("g-123");
  });

  it("属性缺失（null）也翻成未分组，不抛错", () => {
    expect(attrToGroupId(null)).toBe(
      UNGROUPED_ID
    );
  });

  it("占位符不是合法分组名，不会与 randomUUID 撞车", () => {
    expect(UNGROUPED_ATTR).not.toBe(UNGROUPED_ID);
    expect(UNGROUPED_ATTR).toBeTruthy();
  });
});

describe("自定义颜色（HeroUI ColorPicker 产出）", () => {
  it("认#rrggbb 与 #rgb 两种写法", () => {
    expect(isCustomColor("#ff8800")).toBe(true);
    expect(isCustomColor("#f80")).toBe(true);
    expect(isCustomColor("#FF8800")).toBe(true);
  });

  it("拒绝不合法或非字符串的色值", () => {
    expect(isCustomColor("red")).toBe(false);
    expect(isCustomColor("")).toBe(false);
    expect(isCustomColor(undefined)).toBe(false);
    // 5 位 / 8 位 hex 都不是合法 CSS 颜色写法
    expect(isCustomColor("#ff88")).toBe(false);
    expect(isCustomColor("#ff880011")).toBe(
      false
    );
    expect(isCustomColor("#gggggg")).toBe(false);
    // 非 # 开头的颜色函数也不认（本组件只存 hex）
    expect(isCustomColor("rgb(1,2,3)")).toBe(
      false
    );
  });

  it("normalizeColorTag 放行合法 hex，拦下脏值", () => {
    expect(normalizeColorTag("#ff8800")).toBe(
      "#ff8800"
    );
    expect(normalizeColorTag("#f80")).toBe(
      "#f80"
    );
    // ⚠️ 回归：曾一律回退空串，导致用户取的颜色存下来却看不见
    expect(normalizeColorTag("#ff88")).toBe("");
    expect(normalizeColorTag(null)).toBe("");
  });

  it("colorHex 原样返回自定义色值", () => {
    expect(colorHex("#ff8800")).toBe("#ff8800");
  });

  it("色板仍是「具名色 + 空串」，不含自定义色", () => {
    for (const item of COLOR_TAGS) {
      expect(isCustomColor(item.value)).toBe(
        false
      );
    }
  });
});

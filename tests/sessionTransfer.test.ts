import { describe, it, expect } from "vitest";
import {
  buildExportPayload,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  parseImportPayload,
  serializeExport
} from "@/sessions/lib/sessionTransfer";
import {
  localSession,
  type SavedSession
} from "@/sessions/lib/session";
import type { SessionGroup } from "@/sessions/lib/sessionGroup";

function ssh(
  over: Partial<SavedSession> = {}
): SavedSession {
  return {
    id: "s1",
    name: "web-01",
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "ops",
    ...over
  };
}

function group(
  over: Partial<SessionGroup> = {}
): SessionGroup {
  return {
    id: "g1",
    name: "生产",
    color: "red",
    collapsed: false,
    ...over
  };
}

describe("会话导出", () => {
  it("剥掉密码", () => {
    const payload = buildExportPayload(
      [
        ssh({ password: "DPAPI密文不该出现在这" })
      ],
      []
    );
    expect(
      payload.sessions[0]
    ).not.toHaveProperty("password");
    expect(JSON.stringify(payload)).not.toContain(
      "DPAPI密文"
    );
  });

  it("剥掉会话自己的 id（导入时重新生成）", () => {
    const payload = buildExportPayload(
      [ssh()],
      []
    );
    expect(
      payload.sessions[0]
    ).not.toHaveProperty("id");
  });

  it("跳过本机终端", () => {
    const payload = buildExportPayload(
      [localSession],
      []
    );
    expect(payload.sessions).toHaveLength(0);
  });

  it("保留分组 id —— 它是会话 groupId 的引用键", () => {
    const payload = buildExportPayload(
      [ssh({ groupId: "g1" })],
      [group()]
    );
    expect(payload.groups[0]?.id).toBe("g1");
    expect(payload.sessions[0]?.groupId).toBe(
      "g1"
    );
  });

  it("带上格式标识与版本，便于日后判别", () => {
    const payload = buildExportPayload([], []);
    expect(payload.format).toBe(EXPORT_FORMAT);
    expect(payload.version).toBe(EXPORT_VERSION);
  });

  it("序列化成格式化 JSON", () => {
    const text = serializeExport([ssh()], []);
    expect(text).toContain("\n");
    expect(JSON.parse(text).format).toBe(
      EXPORT_FORMAT
    );
  });
});

describe("会话导入：拒绝坏文件", () => {
  it("非 JSON", () => {
    const result = parseImportPayload(
      "这不是 json",
      []
    );
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("应当解析失败");
    expect(result.error).toBeTruthy();
  });

  it("是别的程序的 JSON", () => {
    const result = parseImportPayload(
      JSON.stringify({
        format: "something-else"
      }),
      []
    );
    expect(result.ok).toBe(false);
  });

  it("版本比程序新", () => {
    const result = parseImportPayload(
      JSON.stringify({
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION + 1
      }),
      []
    );
    expect(result.ok).toBe(false);
  });
});

describe("会话导入：id 重映射", () => {
  it("导入后所有 id 都是新的，且互不相同", () => {
    const text = serializeExport(
      [
        ssh(),
        ssh({
          id: "s2",
          name: "db-01",
          host: "10.0.0.2"
        })
      ],
      [group()]
    );
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);

    const ids = result.sessions.map(
      item => item.id
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // 不得沿用文件里的 id
    expect(ids).not.toContain("s1");
    expect(ids).not.toContain("s2");
  });

  it("会话仍挂在正确的分组下（引用被重映射）", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [group()]
    );
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);

    // 分组换了新 id
    const freshGroupId = result.groups[0]?.id;
    expect(freshGroupId).toBeDefined();
    expect(freshGroupId).not.toBe("g1");
    // 会话指向的是新 id，而不是文件里的旧 id
    expect(result.sessions[0]?.groupId).toBe(
      freshGroupId
    );
  });

  it("同一文件导入两次：第二次全部跳过，不会产生重复条目", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [group()]
    );
    const first = parseImportPayload(text, []);
    if (!first.ok) throw new Error(first.error);
    // 把第一次的落地结果当作「现有数据」再导一次同一份文件
    const second = parseImportPayload(
      text,
      first.sessions,
      first.groups
    );
    if (!second.ok) throw new Error(second.error);

    // 一条都导不进来：机器上已经有了
    expect(second.sessions).toHaveLength(0);
    expect(second.skipped).toBe(1);
    // 分组也一个都不新建
    expect(second.groups).toHaveLength(0);
    expect(second.mergedGroups).toBe(1);
  });

  it("引用了不存在的分组时归为未分组，不丢会话", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [] // 分组数组为空
    );
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.groupId).toBe("");
  });
});

describe("会话导入：容错与重复统计", () => {
  it("字段缺失时退到安全默认值", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      sessions: [
        { host: "1.2.3.4", username: "ops" }
      ]
    });
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions[0]?.port).toBe(22);
    expect(result.sessions[0]?.name).toBe(
      "ops@1.2.3.4"
    );
  });

  it("名称为空时回落成 user@host", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      sessions: [
        {
          name: "",
          host: "h",
          username: "u",
          port: 22
        }
      ]
    });
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);
    expect(result.sessions[0]?.name).toBe("u@h");
  });

  it("非法端口退回 22", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      sessions: [
        { name: "x", host: "h", port: "abc" }
      ]
    });
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);
    expect(result.sessions[0]?.port).toBe(22);
  });

  it("非法颜色标记被夹成空串，不污染分组色", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      groups: [
        {
          id: "g",
          name: "g",
          color: "chartreuse"
        }
      ],
      sessions: [
        {
          name: "x",
          host: "h",
          groupId: "g"
        }
      ]
    });
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);
    expect(result.groups[0]?.color).toBe("");
  });

  it("往返一次后连接信息不丢", () => {
    const original = ssh({
      port: 2222,
      color: "blue",
      groupId: "g1"
    });
    const text = serializeExport(
      [original],
      [group()]
    );
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);

    const got = result.sessions[0];
    expect(got?.name).toBe("web-01");
    expect(got?.host).toBe("10.0.0.1");
    expect(got?.port).toBe(2222);
    expect(got?.username).toBe("ops");
    expect(got?.color).toBe("blue");
    expect(got?.groupId).toBe(
      result.groups[0]?.id
    );
  });
});

describe("会话导入：同名分组合并", () => {
  it("分组名与现有分组相同时不新建，会话挂到现有分组上", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [group()] // 文件里的分组叫「生产」
    );
    const result = parseImportPayload(
      text,
      [],
      [group({ id: "existing-1", name: "生产" })]
    );
    if (!result.ok) throw new Error(result.error);

    // 没有新建任何分组
    expect(result.groups).toHaveLength(0);
    expect(result.mergedGroups).toBe(1);
    // 会话指向的是现有分组的 id
    expect(result.sessions[0]?.groupId).toBe(
      "existing-1"
    );
  });

  it("名字不同则照常新建分组", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [group({ name: "测试环境" })]
    );
    const result = parseImportPayload(
      text,
      [],
      [group({ id: "e1", name: "生产" })]
    );
    if (!result.ok) throw new Error(result.error);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.name).toBe(
      "测试环境"
    );
    expect(result.mergedGroups).toBe(0);
    expect(result.sessions[0]?.groupId).toBe(
      result.groups[0]?.id
    );
  });

  it("合并时保留现有分组的名称、颜色与折叠态，不被文件覆盖", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [
        group({
          name: "生产",
          color: "blue",
          collapsed: false
        })
      ]
    );
    const result = parseImportPayload(
      text,
      [],
      [
        group({
          id: "e1",
          name: "生产",
          color: "red",
          collapsed: true
        })
      ]
    );
    if (!result.ok) throw new Error(result.error);

    // 合并的分组根本不进 groups 数组 —— 现有分组对象不会被触碰
    expect(result.groups).toHaveLength(0);
    expect(result.sessions[0]?.groupId).toBe(
      "e1"
    );
  });

  it("大小写与首尾空格差异也算同名", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [group({ name: "  PROD " })]
    );
    const result = parseImportPayload(
      text,
      [],
      [group({ id: "e1", name: "prod" })]
    );
    if (!result.ok) throw new Error(result.error);

    expect(result.groups).toHaveLength(0);
    expect(result.mergedGroups).toBe(1);
    expect(result.sessions[0]?.groupId).toBe(
      "e1"
    );
  });

  it("文件内部自己重名的分组也并到一起", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      groups: [
        { id: "a", name: "生产" },
        { id: "b", name: "生产" },
        { id: "c", name: "测试" }
      ],
      sessions: [
        { name: "s1", host: "h1", groupId: "a" },
        { name: "s2", host: "h2", groupId: "b" },
        { name: "s3", host: "h3", groupId: "c" }
      ]
    });
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);

    // 只新建一个「生产」和一个「测试」
    expect(result.groups).toHaveLength(2);
    // 前两个都挂到同一个分组上
    expect(result.sessions[0]?.groupId).toBe(
      result.sessions[1]?.groupId
    );
    expect(result.sessions[0]?.groupId).not.toBe(
      result.sessions[2]?.groupId
    );
    // 文件里 3 个分组，1 个是内部合并
    expect(result.mergedGroups).toBe(1);
  });

  it("空名分组不参与合并（无从判断是否同一个）", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      groups: [
        { id: "a", name: "" },
        { id: "b", name: "" }
      ],
      sessions: [
        { name: "s1", host: "h1", groupId: "a" },
        { name: "s2", host: "h2", groupId: "b" }
      ]
    });
    // 现有这边也有一个空名分组
    const result = parseImportPayload(
      text,
      [],
      [group({ id: "e1", name: "" })]
    );
    if (!result.ok) throw new Error(result.error);

    // 两个空名分组各自新建，不并进现有的
    expect(result.groups).toHaveLength(2);
    expect(result.mergedGroups).toBe(0);
    expect(result.sessions[0]?.groupId).not.toBe(
      "e1"
    );
  });

  it("同文件导入两次：第二次既不新建分组，也不重复导会话", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [group()]
    );
    const first = parseImportPayload(text, []);
    if (!first.ok) throw new Error(first.error);
    // 第一次的落地结果当作「现有数据」
    const second = parseImportPayload(
      text,
      first.sessions,
      first.groups
    );
    if (!second.ok) throw new Error(second.error);

    // 分组名相同 → 并入第一次建的那个，不新建
    expect(second.groups).toHaveLength(0);
    expect(second.mergedGroups).toBe(1);
    // 连接目标也相同 → 会话被跳过
    expect(second.sessions).toHaveLength(0);
    expect(second.skipped).toBe(1);
  });

  it("多个同名导入分组都并到同一个现有分组", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      groups: [
        { id: "a", name: "生产" },
        { id: "b", name: "生产" },
        { id: "c", name: "生产" }
      ],
      sessions: [
        { name: "s1", host: "h1", groupId: "a" },
        { name: "s2", host: "h2", groupId: "b" },
        { name: "s3", host: "h3", groupId: "c" }
      ]
    });
    const result = parseImportPayload(
      text,
      [],
      [group({ id: "e1", name: "生产" })]
    );
    if (!result.ok) throw new Error(result.error);

    expect(result.groups).toHaveLength(0);
    expect(result.mergedGroups).toBe(3);
    expect(
      result.sessions.every(
        item => item.groupId === "e1"
      )
    ).toBe(true);
  });

  it("不传现有分组时行为不变（向后兼容）", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [group()]
    );
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);

    expect(result.groups).toHaveLength(1);
    expect(result.mergedGroups).toBe(0);
    expect(result.sessions[0]?.groupId).toBe(
      result.groups[0]?.id
    );
  });

  it("合并的分组不覆盖现有分组：现有里的老会话留在原处", () => {
    // 现有：分组 e1「生产」下已有一条会话
    const existingSessions = [
      ssh({ id: "old-1", groupId: "e1" })
    ];
    const existingGroups = [
      group({ id: "e1", name: "生产" })
    ];
    // 导入的是**另一台**机器（否则会被「已有则跳过」挡掉），
    // 但分组名同样是「生产」→ 应并入 e1
    const text = serializeExport(
      [
        ssh({
          id: "new-1",
          host: "10.0.0.9",
          groupId: "g1"
        })
      ],
      [group()]
    );
    const result = parseImportPayload(
      text,
      existingSessions,
      existingGroups
    );
    if (!result.ok) throw new Error(result.error);

    // 导入结果不含任何分组（不新建、不修改）
    expect(result.groups).toHaveLength(0);
    // 新会话与老会话最终同属 e1 —— addManyGroups 不动 e1，
    // 老会话的 groupId 本来就是 e1，天然并排
    expect(result.sessions[0]?.groupId).toBe(
      "e1"
    );
    expect(result.skipped).toBe(0);
    expect(existingSessions[0]?.groupId).toBe(
      "e1"
    );
    expect(existingGroups).toHaveLength(1);
  });
});

describe("会话导入：已有的直接跳过", () => {
  it("连接目标相同的会话整条不导入", () => {
    const text = serializeExport([ssh()], []);
    const result = parseImportPayload(text, [
      ssh({ id: "old" })
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("名字不同但主机账号端口相同 → 照样跳过", () => {
    // 同一台机器，两个人的本地叫法不一样，很常见
    const text = serializeExport(
      [ssh({ name: "生产 web-01" })],
      []
    );
    const result = parseImportPayload(text, [
      ssh({ id: "old", name: "web-01" })
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("颜色或分组不同也算同一条（那只是本地装饰与归类）", () => {
    const text = serializeExport(
      [ssh({ color: "red", groupId: "gx" })],
      [group({ id: "gx", name: "组A" })]
    );
    const result = parseImportPayload(
      text,
      [
        ssh({
          id: "old",
          color: "blue",
          groupId: "gy"
        })
      ],
      [group({ id: "gy", name: "组B" })]
    );
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("主机名不区分大小写", () => {
    const text = serializeExport(
      [ssh({ host: "Web-01" })],
      []
    );
    const result = parseImportPayload(text, [
      ssh({ id: "old", host: "web-01" })
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("用户名不同则照常导入（Linux 上 Root 与 root 是两个人）", () => {
    const text = serializeExport(
      [ssh({ username: "root" })],
      []
    );
    const result = parseImportPayload(text, [
      ssh({ id: "old", username: "ops" })
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });

  it("端口不同则照常导入", () => {
    const text = serializeExport(
      [ssh({ port: 2222 })],
      []
    );
    const result = parseImportPayload(text, [
      ssh({ id: "old", port: 22 })
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });

  it("同一个文件里重复的两条只导一条", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      sessions: [
        { name: "a", host: "h", username: "u" },
        { name: "b", host: "h", username: "u" }
      ]
    });
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.name).toBe("a");
    expect(result.skipped).toBe(1);
  });

  it("已有的跳过、新的照常导入，计数分开", () => {
    const text = serializeExport(
      [
        ssh({ name: "old-one" }),
        ssh({
          name: "new-one",
          host: "10.0.0.7"
        })
      ],
      []
    );
    const result = parseImportPayload(text, [
      ssh({ id: "e1" })
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.name).toBe(
      "new-one"
    );
    expect(result.skipped).toBe(1);
  });

  it("本机终端不会被重复导入", () => {
    // local 必然已在现有会话里（应用启动就建好）
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      sessions: [
        {
          name: "假本机",
          kind: "local",
          host: "localhost",
          port: 0
        }
      ]
    });
    const result = parseImportPayload(text, [
      localSession
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.sessions).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("组内会话全被跳过 → 这个新分组不建（不多个空组）", () => {
    const text = serializeExport(
      [ssh({ groupId: "g1" })],
      [group()]
    );
    const result = parseImportPayload(text, [
      ssh({ id: "old" })
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.skipped).toBe(1);
    expect(result.groups).toHaveLength(0);
  });

  it("分组内部分会话被跳过 → 分组照常建（还有会话要放）", () => {
    const text = serializeExport(
      [
        ssh({ name: "old-one", groupId: "g1" }),
        ssh({
          name: "new-one",
          host: "10.0.0.7",
          groupId: "g1"
        })
      ],
      [group()]
    );
    const result = parseImportPayload(text, [
      ssh({ id: "e1" })
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.skipped).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.groups).toHaveLength(1);
  });

  it("文件里本来就是空分组 → 保留（不能顺手丢掉用户的占位）", () => {
    const text = JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      groups: [{ id: "a", name: "以后放东西" }],
      sessions: []
    });
    const result = parseImportPayload(text, []);
    if (!result.ok) throw new Error(result.error);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.name).toBe(
      "以后放东西"
    );
  });
});

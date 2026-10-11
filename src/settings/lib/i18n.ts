import {
  useMemo,
  useSyncExternalStore
} from "react";
import type { LanguageMode } from "@/settings/lib/settings";

/**
 * 极简 i18n。
 *
 * 没用 i18next 之类的库：本项目只需要「一份字典 + 一个取值函数」，
 * 引入框架反而多一层依赖和一堆用不上的能力。
 *
 * 语言放在**模块级 store** 里而不是 React Context —— 这样任何组件
 * （包括 App 自己）都能直接 `useT()`，不必为 Provider 再拆一层组件。
 * 订阅方式与项目里选区状态的做法一致（`useSyncExternalStore`）。
 */

export type Locale = "zh-CN" | "en-US";

/**
 * 全部界面文案。
 *
 * 键用「区域.用途」命名，方便定位归属；两种语言必须一一对应，
 * `Messages` 类型会对缺失的键报错。
 */
const zhCN = {
  "common.cancel": "取消",
  "common.save": "保存",
  "common.confirm": "确定",

  "app.menu.file": "文件",
  "app.menu.edit": "编辑",
  "app.menu.view": "查看",
  "app.menu.tools": "工具",
  "app.menu.aria": "应用菜单",
  "app.menu.newSsh": "新建 SSH 会话…",
  "app.menu.openLocal": "打开本地终端",
  "app.menu.closeActive": "关闭当前标签",
  "app.menu.quit": "退出",
  "app.menu.find": "查找…",
  "app.menu.maximize": "最大化窗口",
  "app.menu.restore": "还原窗口",
  "app.action.newSession": "新建会话",
  "app.action.openLocal": "打开本地终端",
  "app.action.closeActive": "关闭当前会话",
  "app.action.find": "查找",
  "app.action.copy": "复制",
  "app.action.paste": "粘贴",
  "app.action.selectAll": "全选",
  "app.action.clear": "清屏",
  "app.action.devtools": "开发者工具",
  "app.action.openSftp": "SFTP 窗口",
  "app.action.settings": "设置",
  "app.action.more": "更多",
  "app.action.minimize": "最小化",
  "app.action.maximize": "最大化",
  "app.action.close": "关闭",
  // ⚠️ 这里曾有 app.action.toggleCaseSensitive / app.action.toggleRegex：
  // 查找面板的「区分大小写 / 正则」两个开关原本各有一个全局快捷键，
  // 用户要求取消（作为面板内的局部开关，本就不该有全局键位）。查找面板
  // 自己用的是 terminal.find.caseSensitive / terminal.find.regex。

  "sidebar.title": "会话",
  "sidebar.newSsh": "新建 SSH 会话",
  "sidebar.mine": "我的会话",
  "sidebar.localTerminal": "本机终端",
  "sidebar.noMatch": "没有匹配的会话",
  "sidebar.ungrouped": "未分组",
  "sidebar.ready": "就绪",
  "sidebar.connections": "{count} 个连接",
  "sidebar.collapse": "收起会话栏",
  "sidebar.expand": "展开会话栏",

  "status.toInfo": "切换到信息栏",
  "status.toMacros": "切换到快捷宏",
  "status.info.system": "系统信息",
  "status.info.process": "进程信息",
  "status.info.network": "网络信息",
  "status.info.run": "运行",
  "status.info.load": "负载",
  "status.info.net": "网络",
  "status.notReady": "该面板尚未开放",
  "sys.title": "系统信息",
  "sys.core": "核心指标",
  "sys.cpu": "CPU",
  "sys.mem": "内存",
  "sys.disk": "磁盘",
  "sys.os": "操作系统",
  "sys.kernel": "内核版本",
  "sys.arch": "硬件架构",
  "sys.hostname": "主机名称",
  "sys.cpuInfo": "CPU信息",
  "sys.colName": "名称",
  "sys.colCores": "核心数",
  "sys.colFreq": "频率",
  "sys.colCache": "缓存",
  "sys.colBogo": "BogoMIPS",
  "sys.uUser": "用户",
  "sys.uSystem": "系统",
  "sys.uNice": "Nice",
  "sys.uIdle": "空闲",
  "sys.uIo": "IO",
  "sys.uHardirq": "硬件中断",
  "sys.uSoftirq": "软件中断",
  "sys.uSteal": "实时",
  "sys.memInfo": "内存信息",
  "sys.colTotal": "总量",
  "sys.colUsed": "已用",
  "sys.colFree": "空闲",
  "sys.colShared": "共享",
  "sys.colCacheBuf": "缓存/缓冲",
  "sys.colAvail": "可用",
  "sys.swapInfo": "交换信息",
  "sys.swapName": "交换空间",
  "sys.swapLine": "{used} 已用 {pct} 剩余 {free}",
  "sys.netInfo": "网络接口",
  "sys.colIfName": "接口名称",
  "sys.colRx": "接收数据",
  "sys.colRxRate": "接收速度",
  "sys.colTx": "发送数据",
  "sys.colTxRate": "发送速度",
  "sys.fsInfo": "文件系统",
  "sys.colSize": "大小",
  "sys.colMount": "挂载点",
  "sys.unknown": "未知",
  "sys.loading": "采集中…",
  "sys.refresh": "刷新",
  "proc.title": "进程信息",
  "proc.colPid": "PID",
  "proc.colUser": "用户",
  "proc.colMem": "内存",
  "proc.colCpu": "CPU",
  "proc.colCmd": "名称/命令行",
  "net.title": "网络信息",
  "net.colName": "名称",
  "net.colIp": "监听IP",
  "net.colPort": "端口",
  "net.colIpCount": "IP数",
  "net.colConn": "连接数",
  "net.colRecv": "接收",
  "net.colSend": "发送",
  "sys.tip.core":
    "CPU、内存、磁盘三项最关键资源用量的概览",
  "sys.tip.system":
    "操作系统、内核版本、硬件架构与主机名称",
  "sys.tip.cpuInfo":
    "CPU 型号、核心数、频率、缓存与各项状态占比（占比由两次采样计算）",
  "sys.tip.memInfo":
    "物理内存用量分布：总量、已用、空闲、共享、缓存/缓冲、可用",
  "sys.tip.swapInfo":
    "磁盘交换空间用量，物理内存不足时启用",
  "sys.tip.netInfo":
    "各网络接口的累计收发流量与当前速度（1 秒采样间隔的近似值）",
  "sys.tip.fsInfo":
    "各挂载文件系统的大小、用量与挂载点",

  "ai.title": "AI 助手",
  "ai.placeholder":
    "向 AI 描述你想在服务器上做的事",
  "ai.welcome.title": "欢迎使用运维 AI 助手",
  "ai.welcome.desc":
    "我是一名服务器运维 AI 助手，可以帮助您完成各种服务器运维和管理任务。您可以直接输入需求，我会尽力帮助您解决问题！",
  "ai.welcome.tip.0":
    "磁盘空间不足？可以对我说「帮我清理一下磁盘空间」，我会分析占用并给出清理建议",
  "ai.welcome.tip.1":
    "服务起不来？可以说「帮我排查 nginx 启动失败」，把报错发给我更好",
  "ai.welcome.tip.2":
    "端口被占了？可以说「帮我查一下 8080 端口被谁占用」",
  "ai.welcome.tip.3":
    "CPU 飙高？可以说「帮我看看哪个进程最吃 CPU」，我会定位并给出建议",
  "ai.welcome.tip.4":
    "想查日志？可以说「帮我检索今天 nginx 日志里的 500 错误」",
  "ai.welcome.tip.5":
    "内存吃紧？可以说「帮我分析内存占用最高的 5 个进程」",
  "ai.welcome.tip.6":
    "定时任务没跑？可以说「帮我看看 crontab 里有哪些任务」",
  "ai.welcome.tip.7":
    "想批量操作？把目标描述清楚，我会拆成命令逐步执行并等你确认",
  "ai.input":
    "输入消息或粘贴图片…（Shift+Enter换行）",
  "ai.thinking": "思考中…",
  "ai.thoughtFor": "思考了 {s} 秒",
  "ai.selectModel": "选择模型",
  "ai.noModel": "未配置模型",
  "ai.newChat": "新对话",
  "ai.collapse": "收起助手",
  "ai.expand": "展开助手",
  "ai.history": "历史任务",
  "ai.history.empty": "暂无历史任务",
  "ai.history.rename": "重命名",
  "ai.history.delete": "删除",
  "ai.message.copy": "复制",
  "ai.message.copied": "已复制",
  "ai.message.time": "发送时间",
  "ai.send": "发送",
  "ai.stop": "停止生成",
  "ai.stopHint": "中断本轮回答",
  "ai.queue.hint":
    "排队中 {count} 条，本轮结束后自动发送",
  "ai.queue.handle": "拖动排序",
  "ai.queue.handleHint":
    "按住拖动可调整顺序，聚焦后按上下方向键也能移动",
  "ai.queue.dragging": "拖动中",
  "ai.queue.copy": "复制排队消息",
  "ai.queue.edit": "编辑",
  "ai.queue.saveEdit": "保存修改",
  "ai.queue.cancelEdit": "取消编辑",
  "ai.queue.remove": "从队列移除",
  "ai.menu.attach": "附件",
  "ai.menu.uploadImage": "上传图片",
  "ai.menu.uploadImageHint":
    "选择本地图片，随消息发送给模型识别",
  "ai.menu.removeImage": "移除图片",
  "ai.menu.exec": "执行",
  "ai.menu.autoExecute": "自动执行",
  "ai.menu.autoExecuteHint":
    "开启后只读命令自动执行，无需手动确认",
  "ai.menu.autoApply": "自动应用",
  "ai.menu.autoApplyHint":
    "开启后文件更改自动应用，无需手动点击执行",
  "ai.menu.blacklist": "自动执行黑名单",
  "ai.menu.blacklistHint":
    "黑名单中的命令不会被自动执行，一律弹出确认卡片",
  "ai.blacklist.title": "命令黑名单",
  "ai.blacklist.lead":
    "黑名单中的命令不会被自动执行",
  "ai.blacklist.placeholder":
    "输入命令名称（如：rm）",
  "ai.blacklist.add": "添加",
  "ai.blacklist.clear": "清空黑名单",
  "ai.blacklist.close": "关闭",
  "ai.blacklist.remove": "移除",
  "ai.menu.model": "模型",
  "ai.card.ro": "RO",
  "ai.card.rw": "RW",
  "ai.card.title": "准备执行命令",
  "ai.card.copy": "复制",
  "ai.card.copied": "已复制",
  "ai.card.addMacro": "存为宏",
  "ai.card.added": "已添加",
  "ai.card.result": "执行结果",
  "ai.badge.ro":
    "此命令为只读操作，不会修改服务器状态",
  "ai.badge.rw":
    "此命令会修改服务器状态，点击执行后生效",
  "ai.card.running": "执行中…",
  "ai.card.done": "已完成",
  "ai.card.failed": "已失败",
  "ai.card.waiting": "等待确认",
  "ai.card.execute": "执行",
  "ai.card.background": "后台执行",
  "ai.card.skip": "跳过",

  "session.editTitle": "编辑连接",
  "session.newTitle": "新建连接",
  "session.eyebrow": "SSH 会话",
  "session.name": "会话名称",
  "session.namePlaceholder":
    "选填，留空使用主机地址",
  "session.host": "主机地址",
  "session.port": "端口",
  "session.username": "用户名",
  "session.password": "修改密码",
  "session.passwordPlaceholder": "留空保持原密码",
  "session.authHint":
    "身份验证由系统 SSH 处理，支持已有密钥和 ssh-agent。",
  "session.save": "保存会话",
  "session.remove": "删除会话",
  "session.removeTitle":
    "确定删除会话「{name}」？",
  "session.removeDescription":
    "会话将从列表中移除，保存的连接信息与密码一并清除，此操作不可撤销。",
  "transfer.export": "导出会话",
  "transfer.exportDone": "已导出 {count} 个会话",
  "transfer.exportEmpty": "没有可导出的会话",
  "transfer.exportFailed": "导出失败：{error}",
  "transfer.import": "导入会话",
  "transfer.importTitle":
    "导入 {sessions} 个会话、{groups} 个分组？",
  "transfer.importDescription":
    "导入的会话会分配新的标识；出于安全考虑密码不会被导入，需要重新填写。",
  "transfer.importMerged":
    "{count} 个分组与现有分组同名，会并入现有分组。",
  "transfer.importSkipped":
    "{count} 个会话已存在（同一台机器与账号），将跳过。",
  "transfer.importNothingNew":
    "没有新会话可导入：文件里的 {count} 个会话都已存在。",
  "transfer.importDone":
    "已导入 {sessions} 个会话、{groups} 个分组",
  "transfer.importFailed": "导入失败：{error}",
  "session.hostRequired": "请填写主机地址",
  "session.group": "分组",
  "session.groupPlaceholder":
    "留空为未分组，输入新名字可新建分组",
  "session.groupPlaceholderNew":
    "必填。选已有分组，或输入新名字新建分组",
  "session.groupRequired": "请选择或填写分组",

  "group.title": "会话分组",
  "group.newTitle": "新建分组",
  "group.editTitle": "编辑分组",
  "group.name": "分组名称",
  "group.namePlaceholder":
    "如：生产环境 / 测试环境",
  "group.nameRequired": "请填写分组名称",
  "group.quickPick": "快速选择已有分组",
  "group.save": "保存分组",
  "group.new": "新建分组",
  "group.rename": "重命名分组",
  "group.remove": "删除分组",
  "group.createIn": "在此分组新建会话",
  "group.empty":
    "空分组，点标题行右侧的 + 放入会话",
  "group.removeTitle": "删除这个分组？",
  "group.removeDescription":
    "分组「{name}」下的会话会移回「未分组」，会话本身不会被删除。",

  "colorTag.label": "颜色标记",
  "colorTag.none": "无颜色",
  "colorTag.red": "红色",
  "colorTag.orange": "橙色",
  "colorTag.yellow": "黄色",
  "colorTag.green": "绿色",
  "colorTag.cyan": "青色",
  "colorTag.blue": "蓝色",
  "colorTag.purple": "紫色",
  "colorTag.pink": "粉色",
  "colorTag.gray": "灰色",
  "colorTag.custom": "自定义颜色",
  "colorTag.hex": "色值",
  "colorTag.colorSpace": "色彩空间",
  // 通道标签用 ch 前缀另起一套：colorTag.red 已被色点占用（"红色"），
  // 而通道要的是单字（"红"），不能复用同一个键
  "colorTag.chHue": "色相",
  "colorTag.chSaturation": "饱和度",
  "colorTag.chLightness": "明度",
  "colorTag.chBrightness": "亮度",
  "colorTag.chRed": "红",
  "colorTag.chGreen": "绿",
  "colorTag.chBlue": "蓝",
  "sidebar.searchPlaceholder": "搜索会话",
  "sidebar.empty": "还没有会话",
  "sidebar.connect": "连接",
  "sidebar.edit": "编辑",
  "sidebar.duplicate": "复制会话",
  "sidebar.remove": "删除",

  "terminal.emptyTitle": "选择一个会话开始连接",
  "terminal.emptyDesc":
    "从左侧打开本地终端，或新建一个 SSH 会话。",
  "terminal.newTab": "新建会话",
  "terminal.closeTab": "关闭标签",
  "terminal.closeRight": "关闭右侧会话",
  "terminal.closeOthers": "关闭其他会话",
  "terminal.closeAll": "关闭所有会话",
  "terminal.splitRight": "向右拆分",
  "terminal.splitDown": "向下拆分",
  "terminal.moreTabs": "更多标签",
  "terminal.overflowTabs":
    "{count} 个标签超出显示",
  "terminal.find.placeholder": "查找",
  "terminal.find.prev": "上一个 (Shift+Enter)",
  "terminal.find.next": "下一个 (Enter)",
  "terminal.find.caseSensitive": "区分大小写",
  "terminal.find.regex": "正则表达式",
  "terminal.find.close": "关闭 (Esc)",
  "terminal.find.noMatch": "无匹配",
  "terminal.passwordHint":
    "密码输入不会显示字符或 *，输入完成后直接按 Enter。",
  "terminal.exited": "[会话已结束]",
  "terminal.fontSizeHint": "字号 {size} px",
  "terminal.reconnect.pending":
    "连接断开，{delay} 秒后自动重连（第 {attempt}/{max} 次）",
  "terminal.reconnect.trying":
    "正在重连…（第 {attempt}/{max} 次）",
  "terminal.reconnect.giveUp":
    "自动重连已放弃，可在终端右键菜单里手动重新连接",
  "terminal.confirmClose": "确定关闭这个会话吗？",
  "terminal.needSession": "请先打开一个会话",
  // 快捷键设置页里的动作名（与右键菜单同义，单独成键便于改文案）
  "terminal.reconnect.action": "重新连接",
  "terminal.fullscreen.action": "全屏",

  "macro.title": "快捷宏",
  "macro.add": "新增快捷宏",
  "macro.run": "执行：{command}",
  "macro.edit": "编辑快捷宏",
  "macro.empty":
    "还没有快捷宏，点右侧 + 添加常用命令",
  "macro.editAction": "编辑",
  "macro.deleteAction": "删除",
  "macro.name": "名称",
  "macro.command": "命令",
  "macro.namePlaceholder": "名称（可留空）",
  "macro.commandPlaceholder":
    "命令，例如 git pull\n多行会依次执行（相当于每行敲一次回车）",

  "settings.nav.group": "基础设置",
  "settings.nav.general": "常规",
  "settings.nav.terminal": "终端",
  "settings.nav.colorScheme": "配色方案",
  "settings.nav.models": "模型设置",
  "settings.nav.shortcuts": "快捷键",
  "models.desc":
    "管理自定义模型供应商，配置后可在聊天时选择使用。",
  "models.addProvider": "添加供应商",
  "models.newProvider": "新供应商",
  "models.empty":
    "还没有供应商，点击右上角「添加供应商」开始配置。",
  "models.name": "名称",
  "models.enabled": "启用",
  "models.disableProvider": "禁用供应商",
  "models.enableProvider": "启用供应商",
  "models.deleteProvider": "删除供应商",
  "models.rename": "重命名",
  "models.delete": "删除",
  "models.baseUrl": "Base URL",
  "models.apiFormat": "API 格式",
  "models.format.openai":
    "Chat Completions (/chat/completions)",
  "models.format.anthropic":
    "Anthropic Messages (/v1/messages)",
  "models.format.responses":
    "Responses (/responses)",
  "models.key": "API Key",
  "models.showKey": "显示 / 隐藏密钥",
  "models.list": "模型列表",
  "models.addModel": "添加模型",
  "models.deleteModel": "删除模型",
  "models.modelPlaceholder": "模型名称",
  "models.noModels":
    "当前没有配置模型，添加模型后可在聊天中使用。",
  "models.editModel": "编辑模型配置",
  "models.smartConfig": "智能配置",
  "models.contextWindow": "上下文窗口",
  "models.maxTokens": "最大输出 Token",
  "models.advanced": "高级配置",
  "models.inputTypes": "输入类型",
  "models.inputText": "文本",
  "models.inputImage": "图片",
  "models.inputVideo": "视频",
  "models.inputPdf": "PDF",
  "models.capabilities": "模型能力",
  "models.capStructured": "结构化输出",
  "models.capWebSearch": "原生联网搜索",
  "models.capSysMsg": "对话中系统消息",
  "models.capStructuredDesc":
    "支持通过 JSON Schema 约束模型输出的字段、类型和结构。",
  "models.capWebSearchDesc":
    "支持使用模型接口内置的联网搜索能力。",
  "models.capSysMsgDesc":
    "支持在对话中途插入系统指令。",
  "models.capWarn": "请勿勾选模型不支持的能力。",
  "models.reasoningLevels":
    "推理等级（从低到高）",
  "models.reasoningMapping": "推理参数映射",
  "models.resetForm": "重置表单",
  "models.removeLevel": "移除等级",
  "models.hint.smart":
    "根据模型 ID、Base URL 和 API 格式，为您智能匹配推荐配置。应用会持续更新推荐配置，并自动同步给您。\n\n如果手动修改某项配置，该项将转为手动管理，不再跟随推荐更新；其他配置仍由智能配置管理。",
  "models.hint.context":
    "模型一次可处理的上下文容量，单位为 Token。请勿超过模型的实际上限。",
  "models.hint.maxTokens":
    "模型单次输出可生成的最大 Token 数。",
  "models.hint.input":
    "模型能接收的输入类型；文本为必选且锁定。",
  "models.hint.cap":
    "模型支持的高级能力，用于决定相关功能是否可用。",
  "models.hint.levels":
    "从低到高列出推理等级，用于映射推理强度参数。",
  "models.hint.mapping":
    "使用 CEL 表达式，将当前推理等级 reasoningLevel 映射为模型接口的请求字段。表达式返回的 JSON 对象会合并到实际发送的请求体中。",
  "models.vision": "视觉",
  "models.testModel": "测试模型",
  "models.testing": "正在测试 {name}",
  "models.testOk": "{name} 连接成功",
  "models.testFail": "{name} 连接失败",
  "settings.back": "返回工作区",
  "settings.subtitle":
    "修改后立即写入本地，仅对本机生效",
  // ---- 快捷键自定义 ----
  "shortcuts.hint":
    "点击键位后按下想要的组合键，Esc 取消。建议保留 Ctrl+Shift 前缀 —— 裸 Ctrl+字母 在终端里多为 shell 的行编辑键。",
  "shortcuts.scope.terminal": "终端窗口",
  "shortcuts.scope.sftp": "SFTP 窗口",
  "shortcuts.action.sftpBack": "后退",
  "shortcuts.action.sftpForward": "前进",
  "shortcuts.record": "录制快捷键",
  "shortcuts.listening": "按下组合键…",
  "shortcuts.custom": "已自定义",
  "shortcuts.resetOne": "恢复默认键位",
  "shortcuts.resetAll": "全部恢复默认",
  "shortcuts.customizedCount":
    "已自定义 {count} 项",
  "shortcuts.conflict":
    "该组合键已被「{name}」占用，请换一个",
  "settings.locale.title": "界面语言",
  "settings.locale.desc":
    "选择应用界面的显示语言；跟随系统时读取操作系统的语言设置。",
  "settings.theme.title": "系统主题",
  "settings.theme.desc":
    "跟随系统时会随操作系统的深浅色设置自动切换。",
  "settings.font.title": "终端字体",
  "settings.font.desc":
    "留空时使用内置字体栈；填写后作为首选，缺失时按内置列表回退。",
  "settings.font.default": "默认（{name}）",
  "settings.fontSize.title": "终端字号",
  "settings.fontSize.desc":
    "单位像素，可选 {min} 到 {max}。",
  "settings.scrollback.title": "回滚行数",
  "settings.scrollback.desc":
    "终端在内存里保留的历史输出行数，决定向上能翻多远；越大越占内存，调小会丢掉最老的行。",
  "settings.scrollback.unit": "{value} 行",
  "settings.colorScheme.title": "配色方案",
  "settings.colorScheme.desc":
    "463 个内置方案，点击卡片立即应用到终端，当前方案见顶部预览。",
  "settings.colorScheme.search": "搜索配色方案",
  "settings.colorScheme.current": "当前",
  "settings.colorScheme.dark": "夜间模式",
  "settings.colorScheme.light": "亮色主题",
  "settings.welcome.title": "SSH 欢迎提示",
  "settings.welcome.desc":
    "新 SSH 会话打开时在终端顶部显示功能说明卡片，可随时手动关闭。",
  "settings.completion.title": "命令补全",
  "settings.completion.desc":
    "输入时在光标后以灰色提示历史与常用命令：按 → 整句接受，Ctrl+→ 按词接受。",
  "settings.cursor.title": "光标样式",
  "settings.cursor.desc": "终端光标的形状。",
  "settings.cursor.block": "方块",
  "settings.cursor.underline": "下划线",
  "settings.cursor.bar": "竖线",
  "settings.cursorBlink.title": "光标闪烁",
  "settings.cursorBlink.desc":
    "终端光标是否闪烁。",
  "settings.dataDir.title": "数据存储路径",
  "settings.dataDir.desc":
    "会话、设置与快捷宏的导出目录（默认为用户主目录）。保存后会把现有数据复制到新位置；路径后缀 .tera-shell 不可更改。",
  "settings.dataDir.pick": "选择文件夹",
  "settings.dataDir.placeholder":
    "留空使用默认位置",
  "settings.dataDir.saved": "已写入 {path}",

  "option.system": "跟随系统",
  "option.light": "浅色",
  "option.dark": "深色",
  "option.zhCN": "简体中文",
  "option.enUS": "English"
} as const;

export type MessageKey = keyof typeof zhCN;

const enUS: Record<MessageKey, string> = {
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.confirm": "Confirm",

  "app.menu.file": "File",
  "app.menu.edit": "Edit",
  "app.menu.view": "View",
  "app.menu.tools": "Tools",
  "app.menu.aria": "Application menu",
  "app.menu.newSsh": "New SSH session…",
  "app.menu.openLocal": "Open local terminal",
  "app.menu.closeActive": "Close current tab",
  "app.menu.quit": "Quit",
  "app.menu.find": "Find…",
  "app.menu.maximize": "Maximize window",
  "app.menu.restore": "Restore window",
  "app.action.newSession": "New session",
  "app.action.openLocal": "Open local terminal",
  "app.action.closeActive":
    "Close current session",
  "app.action.find": "Find",
  "app.action.copy": "Copy",
  "app.action.paste": "Paste",
  "app.action.selectAll": "Select all",
  "app.action.clear": "Clear",
  "app.action.devtools": "Developer tools",
  "app.action.openSftp": "SFTP window",
  "app.action.settings": "Settings",
  "app.action.more": "More",
  "app.action.minimize": "Minimize",
  "app.action.maximize": "Maximize",
  "app.action.close": "Close",

  "sidebar.title": "Sessions",
  "sidebar.newSsh": "New SSH session",
  "sidebar.mine": "My sessions",
  "sidebar.localTerminal": "Local terminal",
  "sidebar.noMatch": "No matching sessions",
  "sidebar.ungrouped": "Ungrouped",
  "sidebar.ready": "Ready",
  "sidebar.connections": "{count} connections",
  "sidebar.collapse": "Collapse sidebar",
  "sidebar.expand": "Expand sidebar",

  "status.toInfo": "Switch to info bar",
  "status.toMacros": "Switch to macros",
  "status.info.system": "System",
  "status.info.process": "Processes",
  "status.info.network": "Network",
  "status.info.run": "Uptime",
  "status.info.load": "Load",
  "status.info.net": "Net",
  "status.notReady": "Panel not available yet",
  "sys.title": "System Information",
  "sys.core": "Core Metrics",
  "sys.cpu": "CPU",
  "sys.mem": "Memory",
  "sys.disk": "Disk",
  "sys.os": "OS",
  "sys.kernel": "Kernel",
  "sys.arch": "Architecture",
  "sys.hostname": "Hostname",
  "sys.cpuInfo": "CPU Info",
  "sys.colName": "Name",
  "sys.colCores": "Cores",
  "sys.colFreq": "Frequency",
  "sys.colCache": "Cache",
  "sys.colBogo": "BogoMIPS",
  "sys.uUser": "User",
  "sys.uSystem": "System",
  "sys.uNice": "Nice",
  "sys.uIdle": "Idle",
  "sys.uIo": "IO",
  "sys.uHardirq": "Hard IRQ",
  "sys.uSoftirq": "Soft IRQ",
  "sys.uSteal": "Steal",
  "sys.memInfo": "Memory Info",
  "sys.colTotal": "Total",
  "sys.colUsed": "Used",
  "sys.colFree": "Free",
  "sys.colShared": "Shared",
  "sys.colCacheBuf": "Cached/Buffers",
  "sys.colAvail": "Available",
  "sys.swapInfo": "Swap Info",
  "sys.swapName": "Swap",
  "sys.swapLine": "{used} used {pct} free {free}",
  "sys.netInfo": "Network Interfaces",
  "sys.colIfName": "Interface",
  "sys.colRx": "RX",
  "sys.colRxRate": "RX Rate",
  "sys.colTx": "TX",
  "sys.colTxRate": "TX Rate",
  "sys.fsInfo": "File Systems",
  "sys.colSize": "Size",
  "sys.colMount": "Mount",
  "sys.unknown": "Unknown",
  "sys.loading": "Collecting…",
  "sys.refresh": "Refresh",
  "proc.title": "Process Info",
  "proc.colPid": "PID",
  "proc.colUser": "User",
  "proc.colMem": "Memory",
  "proc.colCpu": "CPU",
  "proc.colCmd": "Name/Command",
  "net.title": "Network Info",
  "net.colName": "Name",
  "net.colIp": "Listening IP",
  "net.colPort": "Port",
  "net.colIpCount": "IPs",
  "net.colConn": "Conns",
  "net.colRecv": "RX",
  "net.colSend": "TX",
  "sys.tip.core":
    "Overview of the three key resources: CPU, memory and disk usage",
  "sys.tip.system":
    "Operating system, kernel version, architecture and hostname",
  "sys.tip.cpuInfo":
    "CPU model, cores, frequency, cache and usage breakdown (computed from two samples)",
  "sys.tip.memInfo":
    "Physical memory breakdown: total, used, free, shared, cached/buffers, available",
  "sys.tip.swapInfo":
    "Disk swap space usage, engaged when physical memory runs out",
  "sys.tip.netInfo":
    "Cumulative traffic and current rate per interface (sampled over ~1s)",
  "sys.tip.fsInfo":
    "Size, usage and mount point of each mounted file system",

  "ai.title": "AI Assistant",
  "ai.placeholder":
    "Describe what you want to do on the server",
  "ai.welcome.title":
    "Welcome to the Ops AI Assistant",
  "ai.welcome.desc":
    "I'm a server operations AI assistant that can help you with all kinds of maintenance and management tasks. Just type your request and I'll do my best to help!",
  "ai.welcome.tip.0":
    'Low disk space? Try "help me clean up disk space" — I\'ll analyze usage and suggest what to remove',
  "ai.welcome.tip.1":
    'Service won\'t start? Try "troubleshoot nginx startup failure" — paste the error for better results',
  "ai.welcome.tip.2":
    'Port taken? Try "find out what is occupying port 8080"',
  "ai.welcome.tip.3":
    'CPU spiking? Try "show me the top process by CPU" and I\'ll track it down',
  "ai.welcome.tip.4":
    'Need logs? Try "search today\'s nginx logs for 500 errors"',
  "ai.welcome.tip.5":
    'Memory tight? Try "analyze the top 5 processes by memory usage"',
  "ai.welcome.tip.6":
    'Cron not firing? Try "list the tasks in my crontab"',
  "ai.welcome.tip.7":
    "Batch operations? Describe the goal and I'll break it into commands, running them step by step with your confirmation",
  "ai.input":
    "Type a message or paste an image… (Shift+Enter for newline)",
  "ai.thinking": "Thinking",
  "ai.thoughtFor": "Thought for {s}s",
  "ai.selectModel": "Select model",
  "ai.noModel": "No model configured",
  "ai.newChat": "New chat",
  "ai.collapse": "Collapse assistant",
  "ai.expand": "Expand assistant",
  "ai.history": "History",
  "ai.history.empty": "No history yet",
  "ai.history.rename": "Rename",
  "ai.history.delete": "Delete",
  "ai.message.copy": "Copy",
  "ai.message.copied": "Copied",
  "ai.message.time": "Sent at",
  "ai.send": "Send",
  "ai.stop": "Stop generating",
  "ai.stopHint": "Interrupt this turn",
  "ai.queue.hint":
    "{count} queued — sending automatically when this turn ends",
  "ai.queue.handle": "Drag to reorder",
  "ai.queue.handleHint":
    "Hold and drag to reorder, or focus and use the arrow keys",
  "ai.queue.dragging": "Dragging",
  "ai.queue.copy": "Copy queued message",
  "ai.queue.edit": "Edit",
  "ai.queue.saveEdit": "Save changes",
  "ai.queue.cancelEdit": "Cancel edit",
  "ai.queue.remove": "Remove from queue",
  "ai.menu.attach": "Attachments",
  "ai.menu.uploadImage": "Upload image",
  "ai.menu.uploadImageHint":
    "Pick local images, sent to the model with the message",
  "ai.menu.removeImage": "Remove image",
  "ai.menu.exec": "Execution",
  "ai.menu.autoExecute": "Auto-execute",
  "ai.menu.autoExecuteHint":
    "Read-only commands run automatically without confirmation",
  "ai.menu.autoApply": "Auto-apply",
  "ai.menu.autoApplyHint":
    "File changes are applied automatically without clicking Execute",
  "ai.menu.blacklist": "Execution blacklist",
  "ai.menu.blacklistHint":
    "Blacklisted commands are never auto-executed; they always wait for confirmation",
  "ai.blacklist.title": "Command blacklist",
  "ai.blacklist.lead":
    "Blacklisted commands are never auto-executed",
  "ai.blacklist.placeholder":
    "Enter a command name (e.g. rm)",
  "ai.blacklist.add": "Add",
  "ai.blacklist.clear": "Clear blacklist",
  "ai.blacklist.close": "Close",
  "ai.blacklist.remove": "Remove",
  "ai.menu.model": "Models",
  "ai.card.ro": "RO",
  "ai.card.rw": "RW",
  "ai.card.title": "Ready to run",
  "ai.card.copy": "Copy",
  "ai.card.copied": "Copied",
  "ai.card.addMacro": "Save as macro",
  "ai.card.added": "Added",
  "ai.card.result": "Result",
  "ai.badge.ro":
    "This command is read-only and will not modify the server",
  "ai.badge.rw":
    "This command modifies the server and takes effect after confirmation",
  "ai.card.running": "Running…",
  "ai.card.done": "Done",
  "ai.card.failed": "Failed",
  "ai.card.waiting": "Awaiting confirmation",
  "ai.card.execute": "Execute",
  "ai.card.background": "Run in background",
  "ai.card.skip": "Skip",

  "session.editTitle": "Edit connection",
  "session.newTitle": "New connection",
  "session.eyebrow": "SSH session",
  "session.name": "Session name",
  "session.namePlaceholder":
    "Optional — falls back to the host",
  "session.host": "Host",
  "session.port": "Port",
  "session.username": "Username",
  "session.password": "Change password",
  "session.passwordPlaceholder":
    "Leave empty to keep the current password",
  "session.authHint":
    "Authentication is handled by the system SSH client, so existing keys and ssh-agent both work.",
  "session.save": "Save session",
  "session.remove": "Delete session",
  "session.removeTitle":
    "Delete session “{name}”?",
  "session.removeDescription":
    "The session is removed from the list and its saved connection details and password are cleared. This cannot be undone.",
  "transfer.export": "Export sessions",
  "transfer.exportDone":
    "Exported {count} sessions",
  "transfer.exportEmpty": "No sessions to export",
  "transfer.exportFailed":
    "Export failed: {error}",
  "transfer.import": "Import sessions",
  "transfer.importTitle":
    "Import {sessions} sessions and {groups} groups?",
  "transfer.importDescription":
    "Imported sessions are given new identifiers. Passwords are never exported, so you will need to re-enter them.",
  "transfer.importMerged":
    "{count} groups share a name with an existing group and will be merged into it.",
  "transfer.importSkipped":
    "{count} sessions already exist (same host and account) and will be skipped.",
  "transfer.importNothingNew":
    "Nothing to import: all {count} sessions in the file already exist.",
  "transfer.importDone":
    "Imported {sessions} sessions and {groups} groups",
  "transfer.importFailed":
    "Import failed: {error}",
  "session.hostRequired": "Host is required",
  "session.group": "Group",
  "session.groupPlaceholder":
    "Empty means ungrouped; type a new name to create one",
  "session.groupPlaceholderNew":
    "Required. Pick an existing group, or type a new name to create one",
  "session.groupRequired":
    "Pick or enter a group",

  "group.title": "Session group",
  "group.newTitle": "New group",
  "group.editTitle": "Edit group",
  "group.name": "Group name",
  "group.namePlaceholder":
    "e.g. Production / Staging",
  "group.nameRequired": "Group name is required",
  "group.quickPick":
    "Quick pick an existing group",
  "group.save": "Save group",
  "group.new": "New group",
  "group.rename": "Rename group",
  "group.remove": "Delete group",
  "group.createIn": "New session in this group",
  "group.empty":
    "Empty group — use + to add sessions",
  "group.removeTitle": "Delete this group?",
  "group.removeDescription":
    "Sessions in “{name}” move back to Ungrouped. The sessions themselves are kept.",

  "colorTag.label": "Color",
  "colorTag.none": "No color",
  "colorTag.red": "Red",
  "colorTag.orange": "Orange",
  "colorTag.yellow": "Yellow",
  "colorTag.green": "Green",
  "colorTag.cyan": "Cyan",
  "colorTag.blue": "Blue",
  "colorTag.purple": "Purple",
  "colorTag.pink": "Pink",
  "colorTag.gray": "Gray",
  "colorTag.custom": "Custom color",
  "colorTag.hex": "Hex",
  "colorTag.colorSpace": "Color space",
  // 通道标签与色点标签分开（色点用 colorTag.red = "Red"）
  "colorTag.chHue": "Hue",
  "colorTag.chSaturation": "Saturation",
  "colorTag.chLightness": "Lightness",
  "colorTag.chBrightness": "Brightness",
  "colorTag.chRed": "R",
  "colorTag.chGreen": "G",
  "colorTag.chBlue": "B",
  "sidebar.searchPlaceholder": "Search sessions",
  "sidebar.empty": "No sessions yet",
  "sidebar.connect": "Connect",
  "sidebar.edit": "Edit",
  "sidebar.duplicate": "Duplicate session",
  "sidebar.remove": "Delete",

  "terminal.emptyTitle":
    "Pick a session to connect",
  "terminal.emptyDesc":
    "Open a local terminal on the left, or create an SSH session.",
  "terminal.newTab": "New session",
  "terminal.closeTab": "Close tab",
  "terminal.closeRight":
    "Close tabs to the right",
  "terminal.closeOthers": "Close other tabs",
  "terminal.closeAll": "Close all tabs",
  "terminal.splitRight": "Split right",
  "terminal.splitDown": "Split down",
  "terminal.moreTabs": "More tabs",
  "terminal.overflowTabs":
    "{count} tabs are out of view",
  "terminal.find.placeholder": "Find",
  "terminal.find.prev": "Previous (Shift+Enter)",
  "terminal.find.next": "Next (Enter)",
  "terminal.find.caseSensitive": "Match case",
  "terminal.find.regex": "Regular expression",
  "terminal.find.close": "Close (Esc)",
  "terminal.find.noMatch": "No matches",
  "terminal.passwordHint":
    "Password input stays hidden — no characters or asterisks. Press Enter when done.",
  "terminal.exited": "[session ended]",
  "terminal.fontSizeHint": "Font size {size} px",
  "terminal.reconnect.pending":
    "Connection lost, reconnecting in {delay}s (attempt {attempt}/{max})",
  "terminal.reconnect.trying":
    "Reconnecting… (attempt {attempt}/{max})",
  "terminal.reconnect.giveUp":
    "Auto-reconnect gave up. Use the terminal context menu to reconnect manually",
  "terminal.confirmClose": "Close this session?",
  "terminal.needSession": "Open a session first",
  "terminal.reconnect.action": "Reconnect",
  "terminal.fullscreen.action": "Fullscreen",

  "macro.title": "Quick macros",
  "macro.add": "Add macro",
  "macro.run": "Run: {command}",
  "macro.edit": "Edit macro",
  "macro.empty":
    "No macros yet — click + on the right to add a command",
  "macro.editAction": "Edit",
  "macro.deleteAction": "Delete",
  "macro.name": "Name",
  "macro.command": "Command",
  "macro.namePlaceholder": "Name (optional)",
  "macro.commandPlaceholder":
    "Command, e.g. git pull\nMultiple lines run in order, as if pressing Enter after each",

  "settings.nav.group": "Basics",
  "settings.nav.general": "General",
  "settings.nav.terminal": "Terminal",
  "settings.nav.colorScheme": "Color scheme",
  "settings.nav.models": "Model providers",
  "settings.nav.shortcuts": "Keyboard shortcuts",
  "models.desc":
    "Manage custom model providers; enabled models can be picked when chatting.",
  "models.addProvider": "Add provider",
  "models.newProvider": "New provider",
  "models.empty":
    "No providers yet — use “Add provider” at the top right.",
  "models.name": "Name",
  "models.enabled": "Enabled",
  "models.disableProvider": "Disable provider",
  "models.enableProvider": "Enable provider",
  "models.deleteProvider": "Delete provider",
  "models.rename": "Rename",
  "models.delete": "Delete",
  "models.baseUrl": "Base URL",
  "models.apiFormat": "API format",
  "models.format.openai":
    "Chat Completions (/chat/completions)",
  "models.format.anthropic":
    "Anthropic Messages (/v1/messages)",
  "models.format.responses":
    "Responses (/responses)",
  "models.key": "API Key",
  "models.showKey": "Show / hide key",
  "models.list": "Models",
  "models.addModel": "Add model",
  "models.deleteModel": "Delete model",
  "models.modelPlaceholder": "Model name",
  "models.noModels":
    "No models configured yet — add one to use it in chat.",
  "models.editModel": "Edit model configuration",
  "models.smartConfig": "Smart config",
  "models.contextWindow": "Context window",
  "models.maxTokens": "Max output tokens",
  "models.advanced": "Advanced",
  "models.inputTypes": "Input types",
  "models.inputText": "Text",
  "models.inputImage": "Image",
  "models.inputVideo": "Video",
  "models.inputPdf": "PDF",
  "models.capabilities": "Capabilities",
  "models.capStructured": "Structured output",
  "models.capWebSearch": "Native web search",
  "models.capSysMsg": "System messages in chat",
  "models.capStructuredDesc":
    "Constrain the model's output fields, types and structure via JSON Schema.",
  "models.capWebSearchDesc":
    "Use the web search built into the model's API.",
  "models.capSysMsgDesc":
    "Insert system instructions mid-conversation.",
  "models.capWarn":
    "Don't enable capabilities the model doesn't support.",
  "models.reasoningLevels":
    "Reasoning levels (low → high)",
  "models.reasoningMapping":
    "Reasoning param mapping",
  "models.resetForm": "Reset form",
  "models.removeLevel": "Remove level",
  "models.hint.smart":
    "Recommended settings are matched automatically from the model ID, Base URL and API format. Recommendations keep updating and sync to you.\n\nIf you edit a setting manually, that item switches to manual management and stops following recommendations; the rest stay under smart config.",
  "models.hint.context":
    "How much context the model handles at once, in tokens. Don't exceed the model's real limit.",
  "models.hint.maxTokens":
    "Maximum tokens the model can generate in one output.",
  "models.hint.input":
    "Input types the model accepts; text is always required.",
  "models.hint.cap":
    "Advanced capabilities the model supports, used to gate related features.",
  "models.hint.levels":
    "Reasoning levels from low to high, used to map reasoning effort parameters.",
  "models.hint.mapping":
    "Use a CEL expression to map the current reasoning level (reasoningLevel) to model request fields. The JSON object returned by the expression is merged into the actual request body.",
  "models.vision": "Vision",
  "models.testModel": "Test model",
  "models.testing": "Testing {name}",
  "models.testOk": "{name} connected",
  "models.testFail": "{name} connection failed",
  "settings.back": "Back to workspace",
  "settings.subtitle":
    "Saved locally and applied to this machine only",
  // ---- 快捷键自定义 ----
  "shortcuts.hint":
    "Click a shortcut then press the key combination. Esc cancels. Keeping the Ctrl+Shift prefix is recommended — bare Ctrl+letter is mostly shell line editing in the terminal.",
  "shortcuts.scope.terminal": "Terminal window",
  "shortcuts.scope.sftp": "SFTP window",
  "shortcuts.action.sftpBack": "Back",
  "shortcuts.action.sftpForward": "Forward",
  "shortcuts.record": "Record shortcut",
  "shortcuts.listening": "Press keys…",
  "shortcuts.custom": "Custom",
  "shortcuts.resetOne": "Reset to default",
  "shortcuts.resetAll": "Reset all",
  "shortcuts.customizedCount":
    "{count} customized",
  "shortcuts.conflict":
    "Already used by “{name}”, pick another one",
  "settings.locale.title": "Interface language",
  "settings.locale.desc":
    "Language used by the app UI. Follows the system setting when set to that.",
  "settings.theme.title": "Theme",
  "settings.theme.desc":
    "Follow system switches automatically with the OS appearance.",
  "settings.font.title": "Terminal font",
  "settings.font.desc":
    "Leave empty to use the built-in stack. A custom family is tried first and falls back to the built-in list.",
  "settings.font.default": "Default ({name})",
  "settings.fontSize.title": "Terminal font size",
  "settings.fontSize.desc":
    "In pixels, pick from {min} to {max}.",
  "settings.scrollback.title": "Scrollback lines",
  "settings.scrollback.desc":
    "Lines of history kept in memory per terminal, which sets how far you can scroll back. Larger values use more memory; shrinking drops the oldest lines.",
  "settings.scrollback.unit": "{value} lines",
  "settings.colorScheme.title": "Color scheme",
  "settings.colorScheme.desc":
    "463 built-in schemes. Click a card to apply it to the terminal instantly; the current one is previewed on top.",
  "settings.colorScheme.search":
    "Search color schemes",
  "settings.colorScheme.current": "Current",
  "settings.colorScheme.dark": "Dark themes",
  "settings.colorScheme.light": "Light themes",
  "settings.welcome.title": "SSH welcome tip",
  "settings.welcome.desc":
    "Show a feature overview card at the top of each new SSH session; dismiss it manually anytime.",
  "settings.completion.title":
    "Command completion",
  "settings.completion.desc":
    "Suggest history and common commands as gray ghost text while typing. Press → to accept the whole suggestion, Ctrl+→ for one word.",
  "settings.cursor.title": "Cursor style",
  "settings.cursor.desc":
    "The shape of the terminal cursor.",
  "settings.cursor.block": "Block",
  "settings.cursor.underline": "Underline",
  "settings.cursor.bar": "Bar",
  "settings.cursorBlink.title": "Cursor blink",
  "settings.cursorBlink.desc":
    "Whether the terminal cursor blinks.",
  "settings.dataDir.title": "Data location",
  "settings.dataDir.desc":
    "Where sessions, settings and macros are exported (defaults to your home directory). Saving copies the current data to the new location; the .tera-shell suffix is fixed.",
  "settings.dataDir.pick": "Choose folder",
  "settings.dataDir.placeholder":
    "Empty uses the default location",
  "settings.dataDir.saved": "Written to {path}",

  "option.system": "Follow system",
  "option.light": "Light",
  "option.dark": "Dark",
  "option.zhCN": "简体中文",
  "option.enUS": "English"
};

const DICTIONARIES: Record<
  Locale,
  Record<MessageKey, string>
> = {
  "zh-CN": zhCN,
  "en-US": enUS
};

/** 翻译函数。`{name}` 形式的占位符由第二参数替换。 */
export type Translator = (
  key: MessageKey,
  vars?: Record<string, string | number>
) => string;

/** 中文是唯一的全量字典，缺键时回退到它。 */
function normalizeLocale(
  locale: LanguageMode
): Locale {
  if (locale === "en-US") return "en-US";
  if (locale === "zh-CN") return "zh-CN";
  // 跟随系统：非中文环境一律给英文
  return navigator.language
    ?.toLowerCase()
    .startsWith("zh")
    ? "zh-CN"
    : "en-US";
}

// ---- 模块级 store：任何组件都能直接读，不必套 Provider ----

let current: Locale = "zh-CN";
const listeners = new Set<() => void>();

/** 由 useSettings 在语言变化时调用。 */
export function setLocale(
  locale: LanguageMode
): void {
  const next = normalizeLocale(locale);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Locale {
  return current;
}

function createTranslator(
  locale: Locale
): Translator {
  const dictionary = DICTIONARIES[locale];
  return (key, vars) => {
    // 英文缺失时回退中文，宁可出现少量中文也不要露出原始键名
    const template =
      dictionary[key] ?? zhCN[key] ?? key;
    if (!vars) return template;
    return template.replace(
      /\{(\w+)\}/g,
      (match, name: string) =>
        name in vars ? String(vars[name]) : match
    );
  };
}

/** 取当前语言的翻译函数；语言切换时使用它的组件会自动重渲染。 */
export function useT(): Translator {
  const locale = useSyncExternalStore(
    subscribe,
    getSnapshot
  );
  return useMemo(
    () => createTranslator(locale),
    [locale]
  );
}

/** 读取当前界面语言；语言切换时同步重渲染。 */
export function useLocale(): Locale {
  return useSyncExternalStore(
    subscribe,
    getSnapshot
  );
}

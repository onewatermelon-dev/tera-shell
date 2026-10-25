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
  "net.openLocal":
    "在本地打开（起临时隧道并开浏览器）",
  "net.tunnelClose": "关闭隧道",
  "session.forward.label": "端口转发",
  "session.forward.add": "添加规则",
  "session.forward.desc":
    "会话连接期间生效：L 本地端口→服务器目标；R 服务器IP:端口→本地目标（公网可达需服务器 sshd 开 GatewayPorts）；D 本地 SOCKS5 代理。",
  "session.forward.listenPort": "本地端口",
  "session.forward.remotePort": "远程端口",
  "session.forward.targetHost": "目标主机",
  "session.forward.targetPort": "目标端口",
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
    "输入消息或粘贴图片…（Shift+Enter换行，@ 引用终端）",
  "ai.thinking": "思考中…",
  "ai.error.rateLimit":
    "模型服务限流，等几秒再试",
  "ai.error.auth":
    "API Key 无效或没有权限，检查设置里的模型配置",
  "ai.error.quota": "额度已用尽，请检查账户余额",
  "ai.error.server": "模型服务异常，稍后重试",
  "ai.error.network":
    "连不上模型服务，检查网络或代理",
  "ai.error.unknown": "请求失败",
  "ai.escalate.title": "以 root 执行（提权）",
  "ai.escalate.on": "提权已启用（点此关闭）",
  "ai.escalate.sudoPlaceholder":
    "sudo 密码（登录账号的）",
  "ai.escalate.suPlaceholder":
    "root 密码（su - 用）",
  "ai.escalate.save": "启用",
  "ai.escalate.clear": "关闭",
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
  "ai.ref.title": "引用终端内容",
  "ai.ref.screen": "当前屏幕",
  "ai.ref.scrollback": "终端回滚",
  "ai.ref.selection": "选中内容",
  "ai.ref.selectionEmpty": "无选区",
  "ai.code.copy": "复制",
  "ai.code.copied": "已复制",
  "ai.code.save": "另存为",
  "ai.code.saveFailed": "保存失败",
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
  "ai.file.title": "准备传输文件",
  "ai.file.upload": "上传到服务器",
  "ai.file.download": "下载到本地",
  "ai.file.local": "本地",
  "ai.file.remote": "服务器",
  "ai.file.pick": "选择文件并传输",
  "ai.file.bytes": "大小",
  "ai.file.hint":
    "本地文件由你在系统弹窗里亲自挑选，AI 无法指定要读取的本地路径。",
  "ai.plan.title": "执行计划",
  "ai.plan.steps": "步骤",
  "ai.plan.approve": "开始执行",
  "ai.plan.reject": "取消",
  "ai.plan.pending": "待批准",
  "ai.plan.running": "执行中 {done}/{total}",
  "ai.plan.done": "已完成",
  "ai.plan.cancelled": "已取消",
  "ai.plan.aborted": "已中止",
  "ai.plan.stepPending": "待执行",
  "ai.plan.stepRunning": "执行中…",
  "ai.plan.stepDone": "已完成",
  "ai.plan.stepFailed": "已失败",
  "ai.plan.stepSkipped": "已跳过",
  "ai.plan.stepExecute": "执行",
  "ai.plan.stepSkip": "跳过",
  "ai.plan.result": "输出",
  "ai.plan.more": "还有 {count} 步",
  "ai.plan.expand": "展开全部",
  "ai.plan.collapse": "收起",
  "ai.question.title": "需要确认",
  "ai.question.answered": "已回答",
  "ai.question.cancelled": "已跳过",
  "ai.question.unanswered": "未回答",
  "ai.question.other": "其他",
  "ai.question.continue": "继续",
  "ai.question.skip": "跳过",
  "ai.question.prev": "上一题",
  "ai.question.next": "下一题",
  "ai.question.progress":
    "第 {current}/{total} 题",
  "ai.edit.title": "修改文件",
  "ai.edit.loading":
    "正在读取文件并生成改动对比…",
  "ai.edit.applying": "正在写回文件…",
  "ai.edit.apply": "应用改动",
  "ai.edit.cancel": "取消",
  "ai.edit.applied": "已应用",
  "ai.edit.cancelled": "已取消",
  "ai.edit.failed": "未应用",
  "ai.editHistory.rollback": "回滚",
  "ai.editHistory.confirm": "再点一次确认",
  "ai.editHistory.hostMismatch":
    "当前会话不是这台主机，无法回滚",
  "ai.hostNotes": "主机档案",
  "ai.hostNotes.save": "保存",
  "ai.hostNotes.saved": "已保存",
  "ai.hostNotes.placeholder":
    "沉淀这台机器的备忘，AI 每次对话都会带上（截断注入前 800 字）：\n\n## 角色\n生产 / 测试\n\n## 入口\nssh 端口、跳板、Web 地址\n\n## 关键路径\nnginx: /etc/nginx/conf.d\n应用: /srv/app\n\n## 已知坑\n重启前先停 worker…\n\n## 常用命令",
  "ai.multiExec": "多机执行",
  "ai.multiExec.noSessions": "还没有 SSH 会话",
  "ai.multiExec.noTargets":
    "选中的会话都无法构造连接目标（密码解密失败或未配置）",
  "ai.multiExec.placeholder":
    "要在所选主机上执行的命令，如：df -h / && uptime",
  "ai.multiExec.selected": "台已选",
  "ai.multiExec.progress":
    "执行中 {done}/{total}…",
  "ai.multiExec.confirm": "确认执行？",
  "ai.multiExec.run": "执行并诊断",
  "ai.usage.input": "输入",
  "ai.usage.output": "输出",
  "ai.usage.cached": "缓存",
  "ai.runbook.export": "导出为 Runbook",
  "ai.runbook.failed": "导出 Runbook 失败",
  "ai.table.title": "数据表",
  "ai.table.filter": "筛选…",
  "ai.table.empty": "没有匹配的行",
  "ai.table.rows": "显示",

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
  "session.jump.label": "跳板机",
  "session.jump.none": "不使用跳板",
  "session.jump.desc":
    "连接时先经所选会话登录（ssh -J），选中会话自身还可再配跳板形成多跳。",
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
  "terminal.detachWindow": "在独立窗口中打开",
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
  "terminal.history.placeholder": "搜索命令历史…",
  "terminal.history.scopeHost": "本机",
  "terminal.history.scopeAll": "全部主机",
  "terminal.history.empty": "没有匹配的命令",
  "terminal.history.hint":
    "↑↓ 选择 · Enter 插入 · Tab 切换范围 · Esc 关闭",
  "terminal.paste.title": "确认粘贴",
  "terminal.paste.lead":
    "粘贴是批量输入，一次回车就会全部执行。请先确认这段内容：",
  "terminal.paste.risk.multiline":
    "多行内容（{lines} 行）",
  "terminal.paste.risk.rmRf": "rm 递归强制删除",
  "terminal.paste.risk.dd": "dd 直接写入设备",
  "terminal.paste.risk.mkfs":
    "格式化文件系统（mkfs）",
  "terminal.paste.risk.chmodRoot":
    "把根目录权限改成 777",
  "terminal.paste.risk.forkBomb":
    "fork bomb（进程炸弹）",
  "terminal.paste.skip": "本会话不再提示",
  "terminal.paste.confirm": "仍然粘贴",
  "terminal.paste.more": "…还有 {count} 行",
  "terminal.failure.title":
    "命令失败（exit {code}）· 看看？",
  "rail.directory": "显示跟随目录",
  "rail.toSessions": "回到会话列表",
  "directory.noSession": "没有活动会话",
  "directory.waiting":
    "等待终端上报目录（需要 shell 集成生效）",
  "directory.loading": "读取中…",
  "directory.emptyDir": "空目录",
  "directory.up": "上级目录",
  "directory.refresh": "刷新",
  "directory.openSftp": "在 SFTP 面板打开此目录",
  "terminal.passwordHint":
    "密码输入不会显示字符或 *，输入完成后直接按 Enter。",
  "terminal.exited": "[会话已结束]",
  "terminal.hostKeyError":
    "主机密钥校验失败：指纹与 known_hosts 不一致（可能是服务器重装，也可能是中间人攻击）。请人工核对服务器指纹后再连接，本次未自动重连。",
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
  "macro.broadcastAction": "发送到全部",
  "macro.broadcastActionHint":
    "发送到当前全部 {count} 个会话标签",
  "macro.broadcastEmpty":
    "只有当前标签，无处可发送",
  "macro.broadcastDone":
    "已发送到 {count} 个会话标签",
  "macro.broadcastNone": "没有可发送的会话标签",
  "macro.broadcastSkipped":
    "已发送到 {count} 个会话，{skipped} 个因断线或本地会话已跳过",
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
  "settings.nav.about": "关于",
  "about.desc":
    "SSH 终端 · AI 助手（Tauri + React）",
  "about.diagnostics.title": "诊断与日志",
  "about.diagnostics.hint":
    "反馈问题前先导出诊断包：近 3 天日志 + 脱敏后的设置 + 版本与系统信息",
  "about.diagnostics.openLogs": "打开日志目录",
  "about.diagnostics.export": "导出诊断包",
  "about.diagnostics.working": "正在打包…",
  "about.diagnostics.done":
    "已保存到 {path}（{files} 个文件）",
  "about.update.title": "版本更新",
  "about.update.check": "检查更新",
  "about.update.checking": "检查中…",
  "about.update.hint":
    "手动检查；不会自动下载安装。",
  "about.update.latest": "已是最新版本。",
  "about.update.newer": "发现新版本",
  "about.update.failed": "检查失败",
  "about.update.network":
    "网络不可达（可在设置里配置代理后重试）",
  "about.update.badPayload": "返回格式异常",
  "about.update.openRelease": "查看更新说明",
  "about.update.allReleases": "全部版本",
  "proxy.title": "网络代理",
  "proxy.desc":
    "让 AI 模型请求与版本检查走代理。关闭时全部直连；填写本机端口可省略协议，如 127.0.0.1:7890。",
  "proxy.enable": "启用代理",
  "proxy.url": "代理地址",
  "proxy.urlPlaceholder": "127.0.0.1:7890",
  "proxy.test": "测试连接",
  "proxy.testing": "测试中…",
  "proxy.invalid.empty": "请填写代理地址",
  "proxy.invalid.scheme":
    "协议不支持，请用 http:// 或 socks5:// 开头",
  "proxy.hint.storage":
    "含凭据的地址会原样保存在本地设置文件中，请勿公开该文件。",
  "proxy.status.ok": "代理可用（{ms} ms）",
  "proxy.status.reachable":
    "已连上代理，但探测站点返回 {status} —— 代理本身可用",
  "proxy.status.fail": "连不上：",
  "notify.title": "系统通知",
  "notify.desc":
    "窗口不在前台时，用系统通知提醒你。省去「一直切来切去盯着」的功夫。",
  "notify.enable": "启用通知",
  "notify.command": "长命令完成",
  "notify.commandHint":
    "命令跑满 5 秒才提醒；终端静默约 1.5 秒视为结束。",
  "notify.ai": "AI 回答完成",
  "notify.aiHint":
    "带模型名与回答开头，认得出是哪个会话。",
  "notify.transfer": "传输结束",
  "notify.transferHint":
    "上传或下载完成、失败时提醒。",
  "about.repo": "GitHub 仓库",
  "about.licenses.title": "开源许可",
  "about.licenses.search": "搜索组件或许可证",
  "about.licenses.empty": "没有匹配的组件",
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
  "settings.lineHeight.title": "行距",
  "settings.lineHeight.desc":
    "字符行之间的间距倍数，改后立即重排行数。",
  "settings.cursorWidth.title": "光标宽度",
  "settings.cursorWidth.desc":
    "竖线 / 下划线光标的粗细（像素），方块光标不受影响。",
  "settings.cursorInactive.title": "失焦光标",
  "settings.cursorInactive.desc":
    "焦点切到其他窗格时的光标形态，便于分辨敲下的命令会进哪个终端。",
  "settings.cursorInactive.outline": "变淡描边",
  "settings.cursorInactive.none": "隐藏",
  "settings.sshKey.title": "默认私钥",
  "settings.sshKey.desc":
    "SSH 连接默认使用的私钥文件（-i）；留空则交给 ssh 走默认密钥与 agent。仅对新建/重连的 SSH 会话生效。",
  "settings.sshKey.pick": "选择文件",
  "settings.sshKey.placeholder":
    "留空使用 ssh 默认行为",
  "settings.sshConfig.title":
    "读取 ~/.ssh/config",
  "settings.sshConfig.desc":
    "让 ssh 读取用户配置里的 Host 别名、ProxyJump 等设置；关掉后一律直连主机地址。",
  "settings.hostKey.title": "主机密钥策略",
  "settings.hostKey.desc":
    "SSH 首次连接时如何处理服务器指纹：新主机自动记住后，指纹再变化会拒绝连接并告警。终端、SFTP 与 AI 命令共用同一份 known_hosts；「每次询问」只有在终端里能当场确认，SFTP 与 AI 通道遇到新主机会拒绝并提示先在终端连接一次。",
  "settings.hostKey.acceptNew": "新主机自动记住",
  "settings.hostKey.ask": "每次询问",
  "settings.hostKey.strict": "仅限已知主机",
  "settings.reduceMotion.title": "减少动效",
  "settings.reduceMotion.desc":
    "关闭标签名滚动、加载动画等持续动效；对晕动敏感或希望界面更安静时开启。",
  "settings.webgl.title": "硬件加速渲染",
  "settings.webgl.desc":
    "用 GPU 绘制终端文字（WebGL）。大输出时滚动与输入更顺滑；关闭后退回普通渲染，若遇到缺色、字形缺失等显示异常可先关掉它。",
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
  "net.openLocal":
    "Open locally (tunnel + browser)",
  "net.tunnelClose": "Close tunnel",
  "session.forward.label": "Port forwards",
  "session.forward.add": "Add rule",
  "session.forward.desc":
    "Active while connected: L local→server; R server-ip:port→local (public access needs sshd GatewayPorts); D local SOCKS5 proxy.",
  "session.forward.listenPort": "Local port",
  "session.forward.remotePort": "Remote port",
  "session.forward.targetHost": "Target host",
  "session.forward.targetPort": "Target port",
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
    "Type a message or paste an image… (Shift+Enter for newline, @ to reference the terminal)",
  "ai.thinking": "Thinking",
  "ai.error.rateLimit":
    "Model service is rate limiting, try again in a few seconds",
  "ai.error.auth":
    "Invalid API key or no permission — check the model settings",
  "ai.error.quota":
    "Quota exhausted, check your account balance",
  "ai.error.server":
    "Model service error, try again later",
  "ai.error.network":
    "Cannot reach the model service — check network or proxy",
  "ai.error.unknown": "Request failed",
  "ai.escalate.title": "Run as root (escalate)",
  "ai.escalate.on":
    "Escalation enabled (click to disable)",
  "ai.escalate.sudoPlaceholder":
    "sudo password (your login)",
  "ai.escalate.suPlaceholder":
    "root password (for su -)",
  "ai.escalate.save": "Enable",
  "ai.escalate.clear": "Disable",
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
  "ai.ref.title": "Reference terminal content",
  "ai.ref.screen": "Current screen",
  "ai.ref.scrollback": "Scrollback",
  "ai.ref.selection": "Selected text",
  "ai.ref.selectionEmpty": "no selection",
  "ai.code.copy": "Copy",
  "ai.code.copied": "Copied",
  "ai.code.save": "Save",
  "ai.code.saveFailed": "Save failed",
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
  "ai.file.title": "Ready to transfer a file",
  "ai.file.upload": "Upload to server",
  "ai.file.download": "Download to local",
  "ai.file.local": "Local",
  "ai.file.remote": "Server",
  "ai.file.pick": "Choose file & transfer",
  "ai.file.bytes": "Size",
  "ai.file.hint":
    "You pick the local file in a system dialog — the AI cannot choose which local path to read.",
  "ai.plan.title": "Execution plan",
  "ai.plan.steps": "Steps",
  "ai.plan.approve": "Start",
  "ai.plan.reject": "Cancel",
  "ai.plan.pending": "Awaiting approval",
  "ai.plan.running": "Running {done}/{total}",
  "ai.plan.done": "Completed",
  "ai.plan.cancelled": "Cancelled",
  "ai.plan.aborted": "Aborted",
  "ai.plan.stepPending": "Pending",
  "ai.plan.stepRunning": "Running…",
  "ai.plan.stepDone": "Done",
  "ai.plan.stepFailed": "Failed",
  "ai.plan.stepSkipped": "Skipped",
  "ai.plan.stepExecute": "Run",
  "ai.plan.stepSkip": "Skip",
  "ai.plan.result": "Output",
  "ai.plan.more": "{count} more steps",
  "ai.plan.expand": "Show all",
  "ai.plan.collapse": "Show less",
  "ai.question.title": "Needs your input",
  "ai.question.answered": "Answered",
  "ai.question.cancelled": "Skipped",
  "ai.question.unanswered": "Not answered",
  "ai.question.other": "Other",
  "ai.question.continue": "Continue",
  "ai.question.skip": "Skip",
  "ai.question.prev": "Previous question",
  "ai.question.next": "Next question",
  "ai.question.progress":
    "Question {current} of {total}",
  "ai.edit.title": "File change",
  "ai.edit.loading":
    "Reading the file and building the diff…",
  "ai.edit.applying": "Writing the file back…",
  "ai.edit.apply": "Apply changes",
  "ai.edit.cancel": "Cancel",
  "ai.edit.applied": "Applied",
  "ai.edit.cancelled": "Cancelled",
  "ai.edit.failed": "Not applied",
  "ai.editHistory.rollback": "Roll back",
  "ai.editHistory.confirm":
    "Click again to confirm",
  "ai.editHistory.hostMismatch":
    "Not connected to this host; rollback unavailable",
  "ai.hostNotes": "Host notes",
  "ai.hostNotes.save": "Save",
  "ai.hostNotes.saved": "Saved",
  "ai.hostNotes.placeholder":
    "Notes about this machine, fed to every AI request (first 800 chars):\n\n## Role\nProduction / staging\n\n## Access\nSSH port, jump host, web URL\n\n## Key paths\nnginx: /etc/nginx/conf.d\napp: /srv/app\n\n## Gotchas\nStop workers before restart…\n\n## Common commands",
  "ai.multiExec": "Multi-host exec",
  "ai.multiExec.noSessions":
    "No SSH sessions yet",
  "ai.multiExec.noTargets":
    "Selected sessions have no usable connection target (decrypt failed or not configured)",
  "ai.multiExec.placeholder":
    "Command to run on the selected hosts, e.g. df -h / && uptime",
  "ai.multiExec.selected": "selected",
  "ai.multiExec.progress":
    "Running {done}/{total}…",
  "ai.multiExec.confirm": "Confirm run?",
  "ai.multiExec.run": "Run & diagnose",
  "ai.usage.input": "in",
  "ai.usage.output": "out",
  "ai.usage.cached": "cached",
  "ai.runbook.export": "Export as runbook",
  "ai.runbook.failed": "Failed to export runbook",
  "ai.table.title": "Table",
  "ai.table.filter": "Filter…",
  "ai.table.empty": "No matching rows",
  "ai.table.rows": "Rows",

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
  "session.jump.label": "Jump host",
  "session.jump.none": "No jump host",
  "session.jump.desc":
    "Connect through the selected session first (ssh -J); the jump session itself can also have one for multi-hop chains.",
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
  "terminal.detachWindow": "Open in new window",
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
  "terminal.history.placeholder":
    "Search command history…",
  "terminal.history.scopeHost": "This host",
  "terminal.history.scopeAll": "All hosts",
  "terminal.history.empty":
    "No matching commands",
  "terminal.history.hint":
    "↑↓ select · Enter insert · Tab switch scope · Esc close",
  "terminal.paste.title": "Confirm paste",
  "terminal.paste.lead":
    "Pasting is bulk input — one Enter runs all of it. Check this first:",
  "terminal.paste.risk.multiline":
    "Multiple lines ({lines})",
  "terminal.paste.risk.rmRf":
    "recursive forced delete (rm -rf)",
  "terminal.paste.risk.dd":
    "raw device write (dd of=)",
  "terminal.paste.risk.mkfs":
    "filesystem format (mkfs)",
  "terminal.paste.risk.chmodRoot":
    "chmod 777 on the root directory",
  "terminal.paste.risk.forkBomb": "fork bomb",
  "terminal.paste.skip":
    "Don't warn again in this session",
  "terminal.paste.confirm": "Paste anyway",
  "terminal.paste.more":
    "…and {count} more lines",
  "terminal.failure.title":
    "Command failed (exit {code}) · Investigate?",
  "rail.directory": "Show followed directory",
  "rail.toSessions": "Back to sessions",
  "directory.noSession": "No active session",
  "directory.waiting":
    "Waiting for the shell to report its directory (needs shell integration)",
  "directory.loading": "Loading…",
  "directory.emptyDir": "Empty directory",
  "directory.up": "Parent directory",
  "directory.refresh": "Refresh",
  "directory.openSftp":
    "Open this directory in SFTP",
  "terminal.passwordHint":
    "Password input stays hidden — no characters or asterisks. Press Enter when done.",
  "terminal.exited": "[session ended]",
  "terminal.hostKeyError":
    "Host key verification failed: the fingerprint does not match known_hosts (server reinstall, or a possible man-in-the-middle attack). Verify the server fingerprint manually before reconnecting; auto-reconnect was skipped.",
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
  "macro.broadcastAction": "Send to all",
  "macro.broadcastActionHint":
    "Send to all {count} open session tabs",
  "macro.broadcastEmpty":
    "Only this tab — nowhere to send",
  "macro.broadcastDone":
    "Sent to {count} session tabs",
  "macro.broadcastNone":
    "No session tab available",
  "macro.broadcastSkipped":
    "Sent to {count} sessions; skipped {skipped} that are disconnected or local",
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
  "settings.nav.about": "About",
  "about.desc":
    "SSH terminal with an AI assistant (Tauri + React)",
  "about.diagnostics.title": "Diagnostics & logs",
  "about.diagnostics.hint":
    "Export a bundle before filing an issue: last 3 days of logs, redacted settings, version and system info",
  "about.diagnostics.openLogs": "Open log folder",
  "about.diagnostics.export":
    "Export diagnostics",
  "about.diagnostics.working": "Packaging…",
  "about.diagnostics.done":
    "Saved to {path} ({files} files)",
  "about.update.title": "Updates",
  "about.update.check": "Check for updates",
  "about.update.checking": "Checking…",
  "about.update.hint":
    "Manual check only — nothing is downloaded or installed automatically.",
  "about.update.latest":
    "You are on the latest version.",
  "about.update.newer": "New version available:",
  "about.update.failed": "Check failed",
  "about.update.network":
    "network unreachable (try again after configuring a proxy)",
  "about.update.badPayload":
    "unexpected response",
  "about.update.openRelease": "Release notes",
  "about.update.allReleases": "All releases",
  "proxy.title": "Network proxy",
  "proxy.desc":
    "Route AI model requests and update checks through a proxy. Everything goes out directly when off; the scheme may be omitted for local ports, e.g. 127.0.0.1:7890.",
  "proxy.enable": "Enable proxy",
  "proxy.url": "Proxy address",
  "proxy.urlPlaceholder": "127.0.0.1:7890",
  "proxy.test": "Test connection",
  "proxy.testing": "Testing…",
  "proxy.invalid.empty": "Enter a proxy address",
  "proxy.invalid.scheme":
    "Unsupported scheme — start with http:// or socks5://",
  "proxy.hint.storage":
    "Addresses with credentials are stored verbatim in your local settings file; do not share it.",
  "proxy.status.ok": "Proxy reachable ({ms} ms)",
  "proxy.status.reachable":
    "Connected through the proxy, but the probe returned {status} — the proxy itself works",
  "proxy.status.fail": "Cannot connect:",
  "notify.title": "System notifications",
  "notify.desc":
    "Get a system notification when the window is in the background — no need to keep switching back to check.",
  "notify.enable": "Enable notifications",
  "notify.command": "Long command finished",
  "notify.commandHint":
    "Only after 5 seconds or more; a command counts as finished after ~1.5s of silence.",
  "notify.ai": "AI answer finished",
  "notify.aiHint":
    "Includes the model name and the start of the answer so you know which chat it was.",
  "notify.transfer": "Transfer finished",
  "notify.transferHint":
    "Notify when an upload or download completes or fails.",
  "about.repo": "GitHub repository",
  "about.licenses.title": "Open source licenses",
  "about.licenses.search":
    "Search package or license",
  "about.licenses.empty": "No matching package",
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
  "settings.lineHeight.title": "Line height",
  "settings.lineHeight.desc":
    "Spacing between character rows, as a multiplier. Rows are recalculated immediately.",
  "settings.cursorWidth.title": "Cursor width",
  "settings.cursorWidth.desc":
    "Thickness of the bar / underline cursor in pixels. Block cursors are unaffected.",
  "settings.cursorInactive.title":
    "Inactive cursor",
  "settings.cursorInactive.desc":
    "Cursor shape when focus moves to another pane, so you can tell where keystrokes go.",
  "settings.cursorInactive.outline":
    "Dim outline",
  "settings.cursorInactive.none": "Hidden",
  "settings.sshKey.title": "Default private key",
  "settings.sshKey.desc":
    "Private key file (-i) used by SSH connections; leave empty to let ssh use its defaults and agent. Applies to new/reconnected SSH sessions.",
  "settings.sshKey.pick": "Choose file",
  "settings.sshKey.placeholder":
    "Empty uses ssh defaults",
  "settings.sshConfig.title":
    "Read ~/.ssh/config",
  "settings.sshConfig.desc":
    "Let ssh honor Host aliases, ProxyJump and other settings from your user config; turn off to always connect to the host address directly.",
  "settings.hostKey.title": "Host key policy",
  "settings.hostKey.desc":
    "How SSH handles server fingerprints on first connect. Once a new host is pinned, a changed fingerprint is rejected with a warning. Terminal, SFTP and AI commands share the same known_hosts; the ask option can only prompt inside the terminal, so the SFTP and AI channels reject unknown hosts and ask you to connect once from the terminal.",
  "settings.hostKey.acceptNew": "Trust new hosts",
  "settings.hostKey.ask": "Ask every time",
  "settings.hostKey.strict": "Known hosts only",
  "settings.reduceMotion.title": "Reduce motion",
  "settings.reduceMotion.desc":
    "Turn off continuous animations such as the scrolling tab name and loading indicator.",
  "settings.webgl.title": "Hardware acceleration",
  "settings.webgl.desc":
    "Draw terminal text with the GPU (WebGL). Keeps scrolling and typing smooth on heavy output. Turn it off to fall back to normal rendering — useful if you hit missing colors or glyphs.",
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

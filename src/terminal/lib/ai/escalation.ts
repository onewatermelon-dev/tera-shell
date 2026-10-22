/**
 * 提权凭据（内存）—— AI 自己 `sudo` / `su -` 用的密码。
 *
 * **为什么是两个字段**：`sudo` 要的是**登录账号**的密码，`su -` 要的是
 * **root** 的密码。合成一个的话，用户填哪个都有一半场景失败
 * （实测踩过：填了 root 密码，`sudo` 一律拒绝，报 "incorrect password"）。
 *
 * 只放内存、不落盘：比登录密码更敏感。代价是重启应用要重输，界面上写明了。
 */

export type EscalationPasswords = {
  /** sudo 用：当前登录账号的密码 */
  sudoPassword: string;
  /** su 用：root 的密码 */
  suPassword: string;
};

/**
 * 凭据绑定在**会话 id** 上：切到别的会话时读取直接返回空，
 * 不依赖任何组件记得去清（漏一次就是拿 A 机器的 root 密码打 B 机器）。
 */
type Stored = EscalationPasswords & {
  sessionId: string;
};

let current: Stored = {
  sessionId: "",
  sudoPassword: "",
  suPassword: ""
};

/** 设置两个密码（各自留空 = 该方式不启用）。 */
export function setEscalationPasswords(
  sessionId: string,
  values: EscalationPasswords
): void {
  current = {
    sessionId,
    sudoPassword: values.sudoPassword.trim(),
    suPassword: values.suPassword.trim()
  };
}

/** 当前会话的凭据；会话对不上时返回空（凭据已失效）。 */
export function getEscalationPasswords(
  sessionId: string
): EscalationPasswords {
  if (current.sessionId !== sessionId) {
    return { sudoPassword: "", suPassword: "" };
  }
  // 只交出两个密码字段：sessionId 是实现细节，别让调用方拿到
  return {
    sudoPassword: current.sudoPassword,
    suPassword: current.suPassword
  };
}

/**
 * 清空全部凭据。
 *
 * 切换会话 / 新建聊天 / 打开历史时都要调：凭据只对**当前这段对话**有效，
 * 换一台机器还拿着上一台的 root 密码是危险的。
 */
export function clearEscalation(): void {
  current = {
    sessionId: "",
    sudoPassword: "",
    suPassword: ""
  };
}

/** 当前会话是否至少配了一个（UI 用来点亮开关）。 */
export function hasEscalationPassword(
  sessionId: string
): boolean {
  const values =
    getEscalationPasswords(sessionId);
  return (
    values.sudoPassword.length > 0 ||
    values.suPassword.length > 0
  );
}

/**
 * 文件传输卡片的落地执行：把本地文件传到服务器 / 把服务器文件取回本地。
 *
 * ## 为什么复用 SFTP 而不是走 run_command
 *
 * 模型用 `run_command` 只能生成文本命令，做不到二进制搬运 ——
 * `base64` 要把整个文件编码进命令字符串（有长度上限），
 * `cat >` 也只能写文本。两个文件传输工具直接复用 `sftp_upload` /
 * `sftp_download`：那边已经有分块传输、进度上报、暂停 / 续传与
 * 同名冲突策略，自己再写一份只会漏掉这些。
 *
 * ## 为什么本地路径由弹窗决定
 *
 * 模型**不能**指定要读哪个本地文件 —— 那等于给它开了一个任意文件读取
 * 的口子（`C:\Users\xxx\.ssh\id_rsa`、`/etc/shadow` 都能要到）。
 * 所以 `fs_pick_file` / `fs_pick_save_path` 弹系统框，用户亲自挑，
 * 模型只提供远程那一侧的路径。
 */
import { logError } from "@/shared/lib/log";
import { invoke } from "@tauri-apps/api/core";
import { notifyDirectoryDirty } from "@/terminal/lib/directory/dirty";
import {
  execTargetOf,
  type SshTarget
} from "@/sessions/lib/sshTarget";
import type { OpenSession } from "../session/terminalTypes";
import {
  trimToolOutput,
  type AiFileCall
} from "./protocol";

/** 后端选文件返回的载荷。 */
type PickedFile = {
  path: string;
  name: string;
  size: number;
};

/** 传输任务 id：进度事件靠它对回卡片，这里只需唯一。 */
function transferId(toolCallId: string): string {
  return `ai-${toolCallId}`;
}

/**
 * 组装 sftp_* 命令要的连接参数。
 *
 * 直接复用会话启动时解析好的目标：密码已解密，跳板链与私钥也一并带上
 * （此前这里只传 host/port/账号/密码，跳板会话的传输会连不上）。
 */
async function connectionOf(
  session: OpenSession | undefined
): Promise<SshTarget> {
  return execTargetOf(session);
}

/** 本次传输成功时回填给模型的文本。 */
function doneContent(call: AiFileCall): string {
  const verb =
    call.direction === "upload" ? "上传" : "下载";
  const bytes = call.bytes ?? 0;
  return trimToolOutput(
    `${verb}成功：${call.remotePath}${
      call.localPath ? ` → ${call.localPath}` : ""
    }\n文件名: ${call.localName ?? ""}\n大小: ${bytes} 字节`
  );
}

/**
 * 用户在系统弹窗里点了取消。
 *
 * 单列一个错误类型而不是复用普通 Error：取消不是故障，卡片文案要用
 * 「已取消」而不是「失败」，也不该在控制台打 error 噪声（真正排障时
 * 一堆取消记录会把真错误淹掉）。
 */
class TransferCancelled extends Error {}

/**
 * 执行一次文件传输，就地修改卡片状态，并返回回填给协议流的 tool 消息。
 *
 * @param call 传输卡片（state / bytes / error 就地修改）
 * @param toolCallId 协议流里配对的 tool_call_id
 * @param skip 用户点了「跳过」：不弹框、不传输
 * @param session 当前会话（取连接信息）
 * @param refresh 状态变化后的重渲染回调
 */
export async function executeFileCall(
  call: AiFileCall,
  toolCallId: string,
  skip: boolean,
  session: OpenSession | undefined,
  refresh: () => void
): Promise<string> {
  if (skip) {
    call.state = "failed";
    call.error = "用户跳过了这次传输";
    return "[用户跳过了这次文件传输，未执行]";
  }
  call.state = "running";
  refresh();
  try {
    const connection =
      await connectionOf(session);
    if (!connection.host) {
      throw new Error(
        "当前会话没有可用的服务器地址"
      );
    }
    if (call.direction === "upload") {
      await runUpload(
        call,
        connection,
        transferId(toolCallId)
      );
    } else {
      await runDownload(
        call,
        connection,
        transferId(toolCallId)
      );
    }
    call.state = "done";
  } catch (reason) {
    call.state = "failed";
    // 取消单列：卡片说「已取消」，控制台只留一条 info，
    // 免得排障时被一堆用户取消淹掉真错误
    if (reason instanceof TransferCancelled) {
      call.error = reason.message;
      console.info(
        "[ai] 用户取消了文件传输",
        call.direction,
        call.remotePath
      );
      refresh();
      return `[用户取消了传输] ${reason.message}`;
    }
    call.error = String(reason);
    logError(
      "[ai] 文件传输失败",
      call.direction,
      call.remotePath,
      reason
    );
    refresh();
    return `[传输失败] ${String(reason)}`;
  }
  refresh();
  return doneContent(call);
}

/** 本地 → 远程：弹「打开文件」框选源文件，再交给 SFTP 上传。 */
async function runUpload(
  call: AiFileCall,
  connection: Awaited<
    ReturnType<typeof connectionOf>
  >,
  id: string
): Promise<void> {
  const picked = await invoke<PickedFile | null>(
    "fs_pick_file"
  );
  if (!picked) {
    throw new TransferCancelled(
      "用户取消了文件选择"
    );
  }
  call.localName = picked.name;
  call.bytes = picked.size;
  await invoke("sftp_upload", {
    job: {
      ...connection,
      local: picked.path,
      remote: call.remotePath,
      id,
      policy: "overwrite"
    }
  });
  // 上传完成远端多了文件，广播一次让目录栏重读
  notifyDirectoryDirty();
  // 记下源文件路径：卡片展示「本地 ⇄ 服务器」两端时要用，
  // 回填给模型的文本里也带上，方便模型确认传的是哪个文件
  call.localPath = picked.path;
}

/** 远程 → 本地：弹「另存为」框选落点，再交给 SFTP 下载。 */
async function runDownload(
  call: AiFileCall,
  connection: Awaited<
    ReturnType<typeof connectionOf>
  >,
  id: string
): Promise<void> {
  const target = await invoke<string | null>(
    "fs_pick_save_path",
    {
      // 只给文件名：远程路径 `C:\...` 会被 Windows 当非法文件名
      suggestedName: remoteFileName(
        call.remotePath
      )
    }
  );
  if (!target) {
    throw new TransferCancelled(
      "用户取消了保存位置选择"
    );
  }
  call.localName = remoteFileName(
    call.remotePath
  );
  await invoke("sftp_download", {
    job: {
      ...connection,
      local: target,
      remote: call.remotePath,
      id,
      policy: "overwrite"
    }
  });
  // 下载在本地落了文件，广播一次（本地目录栏若正看这层就重读）
  notifyDirectoryDirty();
  call.localPath = target;
}

/** 取远程路径的文件名部分（两种分隔符都切）。 */
export function remoteFileName(
  remotePath: string
): string {
  const parts = remotePath.split(/[\\/]/);
  return (
    parts[parts.length - 1]?.trim() || "download"
  );
}

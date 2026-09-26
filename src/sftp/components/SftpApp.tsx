import { useMemo, useState } from "react";
import { Alert } from "@heroui/react";
import { loadSession } from "@/sessions/lib/useSessions";
import SftpWindow from "@/sftp/components/SftpWindow";
import "@/styles/app.scss";

/**
 * 独立 SFTP 窗口的根组件。
 *
 * 后端开窗时把会话 id 放在 URL 上（`?sftp=<id>`），这里据此从本地存储
 * 取回会话再渲染主体。这个窗口里没有终端、没有会话侧栏，只干一件事。
 */
export default function SftpApp({
  sessionId
}: {
  sessionId: string;
}) {
  const session = useMemo(
    () => loadSession(sessionId),
    [sessionId]
  );
  const [error, setError] = useState("");

  // 会话可能已被主窗口删掉，此时给个明确提示而不是白屏
  if (!session) {
    return (
      <div className="sftp-standalone">
        <Alert
          status="danger"
          className="app-toast"
        >
          <Alert.Content>
            <Alert.Description>
              找不到这个会话（可能已被删除），请从主窗口重新打开。
            </Alert.Description>
          </Alert.Content>
        </Alert>
      </div>
    );
  }

  return (
    <div className="sftp-standalone">
      <SftpWindow
        session={session}
        onError={setError}
      />
      {error && (
        <Alert
          status="danger"
          className="app-toast"
          onClick={() => setError("")}
        >
          <Alert.Content>
            <Alert.Description>
              {error}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </div>
  );
}

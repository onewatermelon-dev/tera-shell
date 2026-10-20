//! SFTP 模块门面：按功能拆子模块，本文件只做声明与再导出，
//! 外部（`lib.rs` 命令注册、`ai.rs`、`open.rs` / `rename.rs`）的
//! import 路径与公开 API 保持不变。
//!
//! - `pool`：连接池与会话建立（`SftpPool` / `obtain`；连接底座在 `ssh` 模块）
//! - `browse`：目录浏览与缓存（`sftp_list`）
//! - `transfer`：上传下载与传输控制（进度 / 暂停 / 取消）
//! - `remote_ops`：远程文件操作与 shell 命令（新建 / 删除 / 权限 / 归档 / 用量）
//! - `open` / `rename` / `window`：本地编辑回传 / 重命名 / 独立窗口

pub mod browse;
pub mod open;
pub mod pool;
pub mod remote_ops;
pub mod rename;
pub mod transfer;
pub mod window;

pub use browse::{RemoteEntry, SftpListing, SftpRequest, list};
pub use pool::SftpPool;
pub use remote_ops::{
	archive, chmod, create_remote_file, disk_usage, make_remote_dir,
	remote_fs, remove_remote_path,
};
pub use transfer::{
	TransferJob, Transfers, cancel_transfer, download, pause_transfer,
	resume_transfer, upload,
};
// 只在本 crate 内使用的内部件（`ai.rs` 借会话、`open.rs` / `rename.rs`
// 借连接池与任务解析）：提权后经这里再导出，`crate::sftp::` 根路径不变。
pub(crate) use pool::{Connection, obtain};
pub(crate) use transfer::transfer_target;
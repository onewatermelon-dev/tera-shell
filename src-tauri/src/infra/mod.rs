//! 基础设施层：与业务无关的通用能力。
//!
//! 目前包括日志初始化、凭据加解密与通用 HTTP 出口，供上层各功能域复用。

pub mod http;
pub mod logging;
pub mod secret;

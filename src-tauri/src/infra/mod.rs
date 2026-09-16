//! 基础设施层：与业务无关的通用能力。
//!
//! 目前包括日志初始化与凭据加解密，供上层各功能域复用。

pub mod logging;
pub mod secret;

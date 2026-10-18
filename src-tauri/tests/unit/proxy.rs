//! proxy 模块单元测试：凭据脱敏与代理构造的兜底行为。
//!
//! 由源文件以 `#[path]` 编回对应模块：单元测试要访问私有项（`describe`
//! 是模块内的自由函数），不能放进 cargo 自动发现的集成测试目录根部。

use super::{describe, ProxySettings};

/// 日志里的代理地址必须剔除凭据。
///
/// 这是本模块唯一的"绝不能错"的地方：`http://user:pass@host` 直接打进
/// 日志等于在公网环境泄露代理账号密码。
#[test]
fn 日志描述剔除凭据() {
	// 带用户名密码是最需要防的一类
	assert_eq!(
		describe("http://user:pass@1.2.3.4:7890"),
		"http://1.2.3.4:7890"
	);
	// 只有用户名（部分代理允许无密码）
	assert_eq!(
		describe("http://user@1.2.3.4:7890"),
		"http://1.2.3.4:7890"
	);
	// 无凭据时原样保留：排查时得能看到用户实际填了什么
	assert_eq!(
		describe("http://127.0.0.1:7890"),
		"http://127.0.0.1:7890"
	);
	assert_eq!(
		describe("socks5://127.0.0.1:1080"),
		"socks5://127.0.0.1:1080"
	);
}

/// 未启用代理时不该构造出 Proxy（否则所有请求都被劫持到代理上去）。
#[test]
fn 未启用时不给代理() {
	let settings = ProxySettings {
		enabled: false,
		url: "http://127.0.0.1:7890".into(),
	};
	assert!(settings.to_proxy().is_none());
}

/// 开着开关但地址为空（用户刚点了开关还没填）时同样不构造。
#[test]
fn 空地址不给代理() {
	let settings = ProxySettings {
		enabled: true,
		url: "   ".into(),
	};
	assert!(settings.to_proxy().is_none());
}

/// 垃圾输入不许把构建搞崩。
///
/// ⚠️ 这里刻意**不断言**「垃圾输入一定被拒绝」：reqwest 对代理地址的
/// 解析比想象中宽松（实测 `这不是地址` 会被当作主机名接受，真正报错要
/// 等到发请求时连不上）。因此本模块的兜底策略不是「校验地址」，而是
/// **任何情况下都不 panic、不阻断请求**：能构造出 Proxy 就用，构造失败
/// 才退回直连。
///
/// 用户侧真正拦垃圾输入的是前端 `settings/lib/proxyUrl.ts` 的
/// `checkProxyUrl`，那里有明确的协议白名单。
#[test]
fn 垃圾输入不会让构建失败() {
	for url in [
		"这不是地址",
		"://x",
		"%%%",
		"http://",
		"ftp://1.2.3.4:21",
	] {
		let settings = ProxySettings {
			enabled: true,
			url: url.into(),
		};
		// 不 panic 即达标：返回 None 或 Some 都可接受
		let _ = settings.to_proxy();
	}
}
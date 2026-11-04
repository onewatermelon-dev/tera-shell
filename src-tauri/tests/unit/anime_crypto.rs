//! 动漫加密层集成测试（真实 DLL + 抓包样本）。
//!
//! 按项目规范：单元测试住 tests/unit/，源文件 `#[cfg(test)] #[path]` 编回。

use std::path::PathBuf;

/// 资源目录：cargo test 的工作目录是 src-tauri/。
fn resource_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/anime")
}

/// 抓包样本目录。
fn fixture_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn crypto() -> crate::anime_crypto::AnimeCrypto {
	crate::anime_crypto::AnimeCrypto::new(
		&resource_dir().join("libunicorn.dll"),
		&resource_dir().join("libmagic_cipher.so"),
	)
	.expect("加密引擎初始化")
}

/// 测试设备身份（与参考 App 派生方式一致）。
const MASTER: &str = "7b94a2ab809388c89cdee6751701e638";
const DEVICE_ID: &str = "3aaeaab0df9681170d5f714c058d07c208b1f1c52072bcd94534bc2acd8d1272";

fn ascii_secret() -> Vec<u8> {
	use hmac::Mac;
	let mut mac =
		<hmac::Hmac<sha2::Sha256> as Mac>::new_from_slice(MASTER.as_bytes())
			.unwrap();
	mac.update(b"device:");
	mac.update(DEVICE_ID.as_bytes());
	hex_lower(&mac.finalize().into_bytes()).into_bytes()
}

fn hex_lower(bytes: &[u8]) -> String {
	bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn encrypt_decrypt_roundtrip() {
	let crypto = crypto();
	let plain = b"{\"deviceId\":\"3aaeaab0df9681170d5f714c058d07c208b1f1c52072bcd94534bc2acd8d1272\"}";
	let envelope = crypto
		.encrypt(&ascii_secret(), plain, 1_793_202_068)
		.expect("加密失败");
	assert_eq!(envelope[0], 3, "v3 信封版本字节");
	let plain2 = crypto
		.decrypt(&ascii_secret(), &envelope)
		.expect("解密失败");
	assert_eq!(plain2, plain);
}

#[test]
fn decrypt_reference_negotiate_response() {
	let crypto = crypto();
	let cipher = std::fs::read(fixture_dir().join("negotiate_resp.bin"))
		.expect("抓包样本缺失");
	let plain = crypto
		.decrypt(&ascii_secret(), &cipher)
		.expect("参考响应解密失败");
	let text = String::from_utf8_lossy(&plain);
	assert!(text.contains("操作成功"), "缺成功文案：{text}");
	assert!(text.contains("MagicRC4"), "缺算法清单：{text}");
	assert!(
		text.contains(DEVICE_ID),
		"缺设备 id：{text}"
	);
}

#[test]
fn decrypt_rejects_garbage() {
	let crypto = crypto();
	let bogus = vec![0x03u8, 0, 0, 0, 0, 0, 0, 7, 1, 2, 3];
	assert!(crypto.decrypt(&ascii_secret(), &bogus).is_err());
}

//! 弹幕模块的纯函数锁定：弹弹play 签名算法。
//! 经 danmu.rs 末尾的 `#[path] mod danmu_tests` 编回（访问私有项）。

use super::*;

#[test]
fn 签名算法与参考实现一致() {
	// 参考向量（Node crypto.createHmac('sha256', 'test-secret')
	//   .update('my-app-1' + '1751812345' + '葬送的芙莉莲 第01集')）：
	assert_eq!(
		danmu_sign("test-secret", "my-app-1", "葬送的芙莉莲 第01集", "1751812345"),
		"LAbms1zSFn7TPN+9+K/TsB7OcUENSbgNxtbnkZNBuNY="
	);
}

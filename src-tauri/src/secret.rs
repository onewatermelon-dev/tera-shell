use base64::Engine;

/// 用 Windows DPAPI 加密一段文本（绑定当前登录用户，换用户/换机器无法解密）。
///
/// 返回 base64 编码的密文，可安全存入 localStorage。
#[cfg(target_os = "windows")]
fn dpapi_encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len().try_into().map_err(|_| "数据过长")?,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            windows::core::PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| e.to_string())?;
    }
    let cipher = unsafe {
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        slice.to_vec()
    };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(cipher)
}

/// 解密 dpapi_encrypt 产生的密文。
#[cfg(target_os = "windows")]
fn dpapi_decrypt(cipher: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len().try_into().map_err(|_| "数据过长")?,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| e.to_string())?;
    }
    let plain = unsafe {
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        slice.to_vec()
    };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(plain)
}

/// 前端命令：加密 SSH 密码，返回 base64 密文供持久化。
#[tauri::command]
pub fn encrypt(plain: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let cipher = dpapi_encrypt(plain.as_bytes())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(cipher))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = plain;
        Err("仅支持 Windows 平台".into())
    }
}

/// 前端命令：解密持久化的密码密文，返回明文用于自动登录。
#[tauri::command]
pub fn decrypt(encoded: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let cipher = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .map_err(|e| e.to_string())?;
        let plain = dpapi_decrypt(&cipher)?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = encoded;
        Err("仅支持 Windows 平台".into())
    }
}

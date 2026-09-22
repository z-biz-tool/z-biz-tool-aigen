//! 密钥的加密落盘与原子写（doc/优化方案/04 §2、§5）。
//!
//! 方案取舍：04 §2 允许「OS 密钥库」或「AEAD 加密后落盘」两条路。这里选 AEAD
//! （XChaCha20Poly1305）+ 本机主密钥文件，原因是 keyring 在无 GUI 的 Linux/CI
//! 上不可用（06 R2 的降级要求），而本模块在任何平台都能保证**磁盘上 0 处明文 key**。
//! 主密钥文件与密文同目录、权限 0600：它防的是"配置文件被备份/扫描/误传"，
//! 不防已控制该用户账号的进程——后者由"key 不再下发到渲染进程"来堵（见 commands.rs）。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::XChaCha20Poly1305;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const MASTER_KEY_FILE: &str = "master.key";
const CONFIG_FILE: &str = "config.json";

/// 落盘信封。`v=2` 为加密格式；`v` 缺失代表历史的明文 config.json。
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    pub v: u8,
    pub alg: String,
    pub nonce: String,
    pub ct: String,
}

/// 数据目录：`$HOME/.z-biz-tool-aigen`。测试可用 `AIGEN_DATA_DIR` 重定向，
/// 避免单测读写真实用户配置。
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AIGEN_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".z-biz-tool-aigen")
}

pub fn config_path() -> PathBuf {
    data_dir().join(CONFIG_FILE)
}

fn random_bytes(buf: &mut [u8]) -> Result<(), String> {
    getrandom::getrandom(buf).map_err(|e| format!("随机数生成失败: {}", e))
}

/// 读取（或首次创建）主密钥。
pub fn master_key(dir: &Path) -> Result<[u8; KEY_LEN], String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let path = dir.join(MASTER_KEY_FILE);
    if path.exists() {
        let raw = fs::read(&path).map_err(|e| format!("读取主密钥失败: {}", e))?;
        if raw.len() == KEY_LEN {
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(&raw);
            return Ok(key);
        }
        return Err(format!("主密钥文件长度异常（{} 字节）", raw.len()));
    }
    let mut key = [0u8; KEY_LEN];
    random_bytes(&mut key)?;
    atomic_write(&path, &key)?;
    Ok(key)
}

/// 同目录临时文件 + fsync + rename：崩溃后要么旧值要么新值（04 §5）。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "目标路径无父目录".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;

    let mut tmp_name = path
        .file_name()
        .ok_or_else(|| "目标路径无文件名".to_string())?
        .to_string_lossy()
        .into_owned();
    tmp_name.push_str(".tmp");
    let tmp = dir.join(tmp_name);

    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("创建临时文件失败: {}", e))?;
        f.write_all(bytes)
            .map_err(|e| format!("写入临时文件失败: {}", e))?;
        f.sync_all().map_err(|e| format!("刷盘失败: {}", e))?;
    }
    restrict_perms(&tmp);
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("原子替换失败: {}", e)
    })?;
    // 目录项落盘，确保 rename 在断电后仍然可见
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_perms(_path: &Path) {}

/// 加密任意字节 → 信封。
pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Envelope, String> {
    let mut nonce = [0u8; NONCE_LEN];
    random_bytes(&mut nonce)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|e| format!("主密钥无效: {}", e))?;
    let ct = cipher
        .encrypt(chacha20poly1305::XNonce::from_slice(&nonce), plaintext)
        .map_err(|e| format!("加密失败: {}", e))?;
    Ok(Envelope {
        v: 2,
        alg: "xchacha20poly1305".to_string(),
        nonce: B64.encode(nonce),
        ct: B64.encode(ct),
    })
}

/// 解密信封 → 原始字节。密文被改写时返回 Err（认证加密）。
pub fn open(key: &[u8; KEY_LEN], env: &Envelope) -> Result<Vec<u8>, String> {
    if env.v != 2 {
        return Err(format!("不支持的存储版本: {}", env.v));
    }
    let nonce = B64
        .decode(&env.nonce)
        .map_err(|e| format!("密文头损坏: {}", e))?;
    let ct = B64
        .decode(&env.ct)
        .map_err(|e| format!("密文损坏: {}", e))?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|e| format!("主密钥无效: {}", e))?;
    cipher
        .decrypt(chacha20poly1305::XNonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "解密失败：主密钥与密文不匹配".to_string())
}

#[cfg(test)]
pub(crate) mod test_sandbox {
    use std::sync::{Mutex, MutexGuard};

    /// `AIGEN_DATA_DIR` 是**进程级**环境变量，因此全仓所有 sandbox 测试
    /// 必须共用这一把锁；各模块自带一把会导致互相改写对方的数据目录。
    static SANDBOX_LOCK: Mutex<()> = Mutex::new(());

    pub struct Sandbox {
        _dir: tempfile::TempDir,
        _lock: MutexGuard<'static, ()>,
    }

    impl Sandbox {
        pub fn new() -> Self {
            let _lock = SANDBOX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let _dir = tempfile::tempdir().unwrap();
            std::env::set_var("AIGEN_DATA_DIR", _dir.path());
            Self { _dir, _lock }
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            std::env::remove_var("AIGEN_DATA_DIR");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; KEY_LEN] {
        let mut k = [0u8; KEY_LEN];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    #[test]
    fn seal_open_roundtrip() {
        let msg = b"{\"base_url\":\"https://x\",\"api_key\":\"sk-TEST-secret\"}";
        let env = seal(&key(), msg).unwrap();
        assert_eq!(env.v, 2);
        assert_eq!(open(&key(), &env).unwrap(), msg);
    }

    #[test]
    fn envelope_never_contains_plaintext() {
        let secret = "sk-TEST-DO-NOT-STORE-PLAINTEXT";
        let env = seal(&key(), format!("\"api_key\":\"{secret}\"").as_bytes()).unwrap();
        let json = serde_json::to_string(&env).unwrap();
        assert!(!json.contains(secret), "plaintext key in envelope json");
    }

    #[test]
    fn nonce_is_fresh_per_seal() {
        let a = seal(&key(), b"same").unwrap();
        let b = seal(&key(), b"same").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ct, b.ct);
    }

    #[test]
    fn wrong_key_or_tamored_ct_fails() {
        let env = seal(&key(), b"payload").unwrap();
        assert!(open(&[7u8; KEY_LEN], &env).is_err());

        let mut other = key();
        other[0] = 99;
        let mut forged = seal(&other, b"payload").unwrap();
        forged.ct = B64.encode({
            let mut raw = B64.decode(&forged.ct).unwrap();
            let last = raw.len() - 1;
            raw[last] ^= 0xff;
            raw
        });
        assert!(
            open(&other, &forged).is_err(),
            "AEAD must reject tampered ct"
        );
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!path.with_extension("json.tmp").exists());
        assert_eq!(fs::read_dir(dir.path()).into_iter().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn master_key_is_created_private_and_stable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let k1 = master_key(dir.path()).unwrap();
        let perms = fs::metadata(dir.path().join(MASTER_KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(perms & 0o777, 0o600, "master key must be 0600");
        assert_eq!(
            master_key(dir.path()).unwrap(),
            k1,
            "master key must be stable"
        );
    }

    #[test]
    fn master_key_rejects_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(MASTER_KEY_FILE), b"too-short").unwrap();
        assert!(master_key(dir.path()).is_err());
    }
}

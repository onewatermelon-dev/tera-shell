//! 动漫加密层：参考 App `libmagic_cipher.so`（ARM64）的 Unicorn 仿真封装。
//!
//! 协议要点（逆向实锤，见 memory/anime-r5-table-decoded）：
//! - deviceSecret 以 **ASCII64 hex 字符串**（64 字节）参与加密与解密完整性
//! - init 表：ids = XOR-SHA256("EncryptionSDK.算法名.注册id")，注册顺序
//!   [XOR, RC4, Base64, TEA, ChaCha, Blowfish]，weights = 名字序号 1..6，
//!   shorts = 注册 id（各算法轮密钥长度）
//! - 加密：encryptV3(secret, plain, time_s, 0) → v3 信封（内嵌算法链 id）
//! - 解密：decrypt(secret, envelope) → 明文（ integrity 用同一 secret）
//!
//! unicorn 状态不可跨线程共享，整体挂 Mutex；进程内单例见 [`super::anime`]。

use libloading::Library;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// unicorn 引擎与 .so 只加载一次（DLL 句柄是进程级全局）。
/// 引擎是否已完成 init（算法表注册），进程内一次。
static INITED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ==== Unicorn 常量（抄自官方头文件 unicorn.h / arm64.h） ====
const UC_ARCH_ARM64: i32 = 2;
const UC_MODE_LITTLE_ENDIAN: i32 = 0;
const UC_HOOK_CODE: i32 = 1 << 2;
const UC_PROT_ALL: u32 = 1 | 2 | 4;
// ARM64 寄存器编号
const REG_LR: i32 = 2; // X30
const REG_SP: i32 = 4;
const REG_X0: i32 = 199;
const REG_PC: i32 = 260;
const REG_TPIDR_EL0: i32 = 262;

const BASE: u64 = 0x1000_0000; // .so 映射基址 = 文件内虚拟地址
const STACK: u64 = 0x2000_0000;
const STACK_TOP: u64 = STACK + 0x40_0000;
const HEAP: u64 = 0x3000_0000; // guest bump 堆（hook 里用）
const MAGIC: u64 = 0x4000_0000; // 导入魔数页（每项 0x10）
const TLS: u64 = 0x5000_0000;
const RET_MAGIC: u64 = 0x4fff_f000; // 调用返回哨兵
const SCRATCH: u64 = 0x6000_0000; // 宿主侧缓冲
/// 宿主侧仿真堆上限（SCRATCH 映射了 1MB，前 512KB 给引擎自用）
const SCRATCH_END: u64 = SCRATCH + 0x10_0000;
/// 每次调用复位的分配游标
///
/// ⚠️ 早期这里用函数内 `static NEXT` 只增不减：一次播放要 encrypt/decrypt 六七次，
/// 每次切一块且从不回收，几十次播放后游标走出映射区，unicorn 直接
/// `UC_ERR_READ_UNMAPPED`（表现是"用久了加密必崩"）。现在每次进加解密前复位。
static ALLOC_NEXT: AtomicU64 = AtomicU64::new(SCRATCH + 0x8_0000);

/// 复位仿真堆游标（调用方已持锁，无并发）。
fn reset_alloc() {
	ALLOC_NEXT.store(SCRATCH + 0x8_0000, Ordering::Relaxed);
}

type UcEngine = *mut c_void;
type CodeCb = unsafe extern "C" fn(uc: UcEngine, address: u64, size: u32, user_data: *mut c_void);

struct Uc {
	lib: Library,
	handle: UcEngine,
	/// 魔数地址 → 导入名（hook 回调查表用）
	imports: HashMap<u64, String>,
}
/// 句柄裸指针跨线程：所有访问经 Mutex 串行化（AnimeCrypto），移动安全。
unsafe impl Send for Uc {}

impl Uc {
	fn open(dll: &std::path::Path) -> Result<Self, String> {
		let lib = unsafe { Library::new(dll) }
			.map_err(|e| format!("加载 libunicorn.dll 失败：{e}"))?;
		let uc_open: unsafe extern "C" fn(i32, i32, *mut UcEngine) -> i32 =
			*unsafe { lib.get(b"uc_open") }.map_err(|e| e.to_string())?;
		let mut handle: UcEngine = std::ptr::null_mut();
		let rc = unsafe { uc_open(UC_ARCH_ARM64, UC_MODE_LITTLE_ENDIAN, &mut handle) };
		if rc != 0 {
			return Err(format!("uc_open 失败 rc={rc}"));
		}
		Ok(Uc {
			lib,
			handle,
			imports: HashMap::new(),
		})
	}

	fn mem_map(&self, addr: u64, size: usize) -> Result<(), String> {
		let f: unsafe extern "C" fn(UcEngine, u64, usize, u32) -> i32 =
			*unsafe { self.lib.get(b"uc_mem_map") }.map_err(|e| e.to_string())?;
		let rc = unsafe { f(self.handle, addr, size, UC_PROT_ALL) };
		if rc == 0 {
			Ok(())
		} else {
			Err(format!("uc_mem_map 0x{addr:x} rc={rc}"))
		}
	}

	fn mem_write(&self, addr: u64, data: &[u8]) {
		if data.is_empty() {
			return;
		}
		let f: unsafe extern "C" fn(UcEngine, u64, *const u8, usize) -> i32 =
			*unsafe { self.lib.get(b"uc_mem_write") }.unwrap();
		let _ = unsafe { f(self.handle, addr, data.as_ptr(), data.len()) };
	}

	fn mem_read(&self, addr: u64, len: usize) -> Vec<u8> {
		if len == 0 {
			return Vec::new();
		}
		let f: unsafe extern "C" fn(UcEngine, u64, *mut u8, usize) -> i32 =
			*unsafe { self.lib.get(b"uc_mem_read") }.unwrap();
		let mut buf = vec![0u8; len];
		let _ = unsafe { f(self.handle, addr, buf.as_mut_ptr(), len) };
		buf
	}

	fn reg_write(&self, reg: i32, value: u64) {
		let f: unsafe extern "C" fn(UcEngine, i32, *const u64) -> i32 =
			*unsafe { self.lib.get(b"uc_reg_write") }.unwrap();
		let _ = unsafe { f(self.handle, reg, &value) };
	}

	fn reg_read(&self, reg: i32) -> u64 {
		let f: unsafe extern "C" fn(UcEngine, i32, *mut u64) -> i32 =
			*unsafe { self.lib.get(b"uc_reg_read") }.unwrap();
		let mut v: u64 = 0;
		let _ = unsafe { f(self.handle, reg, &mut v) };
		v
	}

	fn emu_start(&self, begin: u64, until: u64) -> Result<(), String> {
		let f: unsafe extern "C" fn(UcEngine, u64, u64, u64, usize) -> i32 =
			*unsafe { self.lib.get(b"uc_emu_start") }.map_err(|e| e.to_string())?;
		let rc = unsafe { f(self.handle, begin, until, 0, 0) };
		if rc == 0 {
			Ok(())
		} else {
			let efn: unsafe extern "C" fn(i32) -> *const i8 =
				*unsafe { self.lib.get(b"uc_strerror") }.map_err(|e| e.to_string())?;
			let msg = unsafe { std::ffi::CStr::from_ptr(efn(rc)) }
				.to_string_lossy()
				.into_owned();
			Err(format!("rc={rc} ({msg})"))
		}
	}

	fn hook_code(&self, begin: u64, end: u64, cb: CodeCb, user_data: *mut c_void) -> Result<(), String> {
		let f: unsafe extern "C" fn(
			UcEngine,
			*mut *mut c_void,
			i32,
			CodeCb,
			*mut c_void,
			u64,
			u64,
		) -> i32 = *unsafe { self.lib.get(b"uc_hook_add") }.map_err(|e| e.to_string())?;
		let mut hook: *mut c_void = std::ptr::null_mut();
		let rc = unsafe { f(self.handle, &mut hook, UC_HOOK_CODE, cb, user_data, begin, end) };
		if rc == 0 {
			Ok(())
		} else {
			Err(format!("uc_hook_add rc={rc}"))
		}
	}

}

/// hook 的 user_data：指向 Uc 的裸指针（回调里用它反查 API 与导入表）。
/// 全域空 hook：规避 unicorn2 快速翻译缓存对混淆指令的宿主段错误。
unsafe extern "C" fn noop_hook(_uc: UcEngine, _a: u64, _s: u32, _ud: *mut c_void) {
}

#[allow(unsafe_op_in_unsafe_fn, unused_variables)]
unsafe extern "C" fn import_hook(
	uc: UcEngine,
	address: u64,
	_size: u32,
	user_data: *mut c_void,
) {
	let uc_ref = &*(user_data as *const Uc);
	let name = match uc_ref.imports.get(&address) {
		Some(n) => n.clone(),
		None => format!("magic_{address:x}"),
	};
	let arg = |i: i32| uc_ref.reg_read(REG_X0 + i);
	let lr = uc_ref.reg_read(REG_LR);
	let rd = |a: u64, n: usize| uc_ref.mem_read(a, n);
	let wr = |a: u64, d: &[u8]| uc_ref.mem_write(a, d);
	let ret = |v: u64| {
		uc_ref.reg_write(REG_X0, v);
		uc_ref.reg_write(REG_PC, lr);
	};
	match name.as_str() {
		"malloc" => {
			let n = arg(0) as usize;
			let p = HEAP_NEXT.fetch_add(((n + 15) & !15) as u64 + 16, Ordering::Relaxed);
			ret(p);
		}
		"free" => ret(0),
		"calloc" => {
			let n = (arg(0) * arg(1)) as usize;
			let p = HEAP_NEXT.fetch_add(((n + 15) & !15) as u64 + 16, Ordering::Relaxed);
			wr(p, &vec![0u8; n]);
			ret(p);
		}
		"realloc" => {
			let old = arg(0);
			let n = arg(1) as usize;
			let newp = HEAP_NEXT.fetch_add(((n + 15) & !15) as u64 + 16, Ordering::Relaxed);
			if old != 0 && n > 0 {
				let data = rd(old, n);
				wr(newp, &data);
			}
			ret(newp);
		}
		"memcpy" | "__memcpy_chk" | "memmove" => {
			let (d, s, n) = (arg(0), arg(1), arg(2) as usize);
			if n > 0 && n < 0x10_0000 {
				let data = rd(s, n);
				wr(d, &data);
			}
			ret(d);
		}
		"memset" => {
			let (d, c, n) = (arg(0), arg(1) as u8, arg(2) as usize);
			if n > 0 && n < 0x10_0000 {
				wr(d, &vec![c; n]);
			}
			ret(d);
		}
		"memcmp" => {
			let (a, b, n) = (arg(0), arg(1), arg(2) as usize);
			let da = rd(a, n);
			let db = rd(b, n);
			let diff = da
				.iter()
				.zip(db.iter())
				.find(|(x, y)| x != y)
				.map(|(x, y)| (*x as i64).wrapping_sub(*y as i64))
				.unwrap_or(0);
			ret(if diff == 0 {
				0
			} else if diff < 0 {
				u64::MAX
			} else {
				1
			});
		}
		"strlen" => {
			let mut n: usize = 0usize;
			let mut p: u64 = arg(0);
			loop {
				let b = rd(p, 1);
				if b.is_empty() || b[0] == 0 || n > 8192 {
					break;
				}
				n += 1;
				p += 1;
			}
			ret(n as u64);
		}
		"__errno" => ret(TLS + 0x100),
		"__open_2" => {
			// 打印请求的路径（guest 内存里的 C 字符串）
			let p = arg(0);
			let mut path = Vec::new();
			for i in 0..128u64 {
				let b = rd(p + i, 1)[0];
				if b == 0 { break; }
				path.push(b);
			}
			ret(RANDOM_FD);
		},
		"__read_chk" => {
			// 假 urandom：固定种子 xorshift64，输出可复现
			let (fd, buf, len) = (arg(0), arg(1), arg(2) as usize);
			let _ = fd;
			let mut x = *RAND_STATE.lock().unwrap();
			let mut out = Vec::with_capacity(len);
			for _ in 0..len {
				x ^= x << 13;
				x ^= x >> 7;
				x ^= x << 17;
				out.push((x & 0xff) as u8);
			}
			*RAND_STATE.lock().unwrap() = x;
			wr(buf, &out);
			ret(len as u64);
		},
		"getrandom" => {
			let (buf, len) = (arg(0), arg(1) as usize);
			let mut x = *RAND_STATE.lock().unwrap();
			let mut out = Vec::with_capacity(len);
			for _ in 0..len {
				x ^= x << 13;
				x ^= x >> 7;
				x ^= x << 17;
				out.push((x & 0xff) as u8);
			}
			*RAND_STATE.lock().unwrap() = x;
			wr(buf, &out);
			ret(len as u64);
		},
		"close" => ret(0),
		"__cxa_atexit" | "__cxa_finalize" | "__register_atfork" | "pthread_once" => ret(0),
		"__stack_chk_fail" => {
			tracing::warn!("动漫加密引擎栈守卫不匹配");
			ret(0);
		}
		other => {
			tracing::debug!(other, "动漫加密引擎未实现导入");
			ret(0);
		}
	}
}

static HEAP_NEXT: AtomicU64 = AtomicU64::new(HEAP + 0x1000);
const RANDOM_FD: u64 = 0x4242;
static RAND_STATE: std::sync::Mutex<u64> = std::sync::Mutex::new(0x0123_4567_89ab_cdef);

struct Machine {
	uc: Box<Uc>,
}

impl Machine {
	fn load(so: &[u8], dll: &std::path::Path) -> Result<Self, String> {
		let elf = goblin::elf::Elf::parse(so).map_err(|e| format!("ELF 解析失败：{e}"))?;
		let mut uc = Uc::open(dll)?;
		// 1) 映射 PT_LOAD 段（整段一次性映射，避免页重叠冲突）
		let mut lo = u64::MAX;
		let mut hi = 0u64;
		for ph in elf.program_headers.iter() {
			if ph.p_type == goblin::elf::program_header::PT_LOAD {
				lo = lo.min(BASE + ph.p_vaddr);
				hi = hi.max(BASE + ph.p_vaddr + ph.p_memsz);
			}
		}
		let span = ((hi - lo + 0xfff) & !0xfff) as usize;
		uc.mem_map(lo, span)?;
		for ph in elf.program_headers.iter() {
			if ph.p_type == goblin::elf::program_header::PT_LOAD {
				let va = BASE + ph.p_vaddr;
				let end = (ph.p_offset + ph.p_filesz) as usize;
				let src = &so[ph.p_offset as usize..end];
				uc.mem_write(va, src);
			}
		}
		// 2) 辅助区
		uc.mem_map(STACK, (STACK_TOP - STACK) as usize)?;
		uc.mem_map(HEAP, 0x200_0000)?;
		uc.mem_map(MAGIC, 0x1000)?;
		uc.mem_map(TLS, 0x1000)?;
		uc.mem_map(RET_MAGIC, 0x1000)?;
		uc.mem_map(SCRATCH, 0x10_0000)?;
		uc.reg_write(REG_TPIDR_EL0, TLS);
		uc.mem_write(TLS + 0x28, &0xdead_beefu64.to_le_bytes());
		// 3) 重定位：RELATIVE = base+addend；JUMP_SLOT/GLOB_DAT = 导入魔数
		let mut imports: HashMap<u64, String> = HashMap::new();
		let mut magic: u64 = MAGIC + 0x100;
		for r in elf.dynrelas.iter().chain(elf.dynrels.iter()).chain(elf.pltrelocs.iter()) {
			let addr = BASE + r.r_offset;
			match r.r_type {
				goblin::elf::reloc::R_AARCH64_RELATIVE => {
					let val = BASE.wrapping_add(r.r_addend.unwrap_or(0) as u64);
					uc.mem_write(addr, &val.to_le_bytes());
				}
				goblin::elf::reloc::R_AARCH64_ABS64 => {
					// *addr = S + A（标准语义）。S：已定义符号=base+st_value；
					// 未定义=导入魔数（代码立即数与 addend 对消后恰好落在魔数上，hook 接管）
					let sym = elf.dynsyms.get(r.r_sym).ok_or("符号越界")?;
					let a = r.r_addend.unwrap_or(0) as u64;
					if sym.st_shndx != 0 {
						let val = BASE.wrapping_add(sym.st_value).wrapping_add(a);
						uc.mem_write(addr, &val.to_le_bytes());
					} else {
						let name = elf
							.dynstrtab
							.get_at(sym.st_name)
							.unwrap_or("")
							.to_string();
						uc.mem_write(addr, &magic.wrapping_add(a).to_le_bytes());
						imports.insert(magic, name);
						magic += 0x10;
					}
				}
				goblin::elf::reloc::R_AARCH64_JUMP_SLOT
				| goblin::elf::reloc::R_AARCH64_GLOB_DAT => {
					let sym = elf.dynsyms.get(r.r_sym).ok_or("符号越界")?;
					if sym.st_shndx != 0 {
						// 本库内定义的符号：GOT 填符号自身地址
						let val = BASE + sym.st_value;
						uc.mem_write(addr, &val.to_le_bytes());
					} else {
						let name = elf
							.dynstrtab
							.get_at(sym.st_name)
							.unwrap_or("")
							.to_string();
						uc.mem_write(addr, &magic.to_le_bytes());
						imports.insert(magic, name);
						magic += 0x10;
					}
				}
				_ => {}
			}
		}
		uc.imports = imports;
		// 4) 挂导入拦截 hook（user_data 带上 Uc 指针；Box 保证堆地址稳定，
		//    后续 Machine 搬移不会让 hook 里的指针悬垂）
		let uc = Box::new(uc);
		let user_data = &*uc as *const Uc as *mut c_void;
		// 全区空 hook：规避 unicorn2 快速翻译缓存对混淆指令的宿主段错误
		uc.hook_code(BASE, BASE + 0x30000, noop_hook, user_data)?;
		uc.hook_code(MAGIC, MAGIC + 0xfff, import_hook, user_data)?;
		// let _ = uc.hook_mem_fault();
		let machine = Machine { uc };
		// 5) 跑 INIT_ARRAY（全局构造；厂商的指针自解密就在这里）
		for sh in elf.section_headers.iter() {
			if sh.sh_type == goblin::elf::section_header::SHT_INIT_ARRAY {
				let va = BASE + sh.sh_addr;
				let n = (sh.sh_size / 8) as usize;
				let blob = machine.uc.mem_read(va, n * 8);
				for i in 0..n {
					let f = u64::from_le_bytes(blob[i * 8..i * 8 + 8].try_into().unwrap());
					if f == 0 {
						continue;
					}
					tracing::trace!(addr = format!("{:#x}", BASE + f), "init_array 调用");
					if let Err(e) = machine.call_raw(BASE + f, &[]) {
						tracing::warn!(error = %e, "init_array 失败");
					}
				}
			}
		}
		Ok(machine)
	}

	fn call_raw(&self, faddr: u64, args: &[u64]) -> Result<u64, String> {
		self.uc.reg_write(REG_SP, STACK_TOP - 0x1000);
		for (i, v) in args.iter().enumerate().take(8) {
			self.uc.reg_write(REG_X0 + i as i32, *v);
		}
		self.uc.reg_write(REG_LR, RET_MAGIC);
		if let Err(e) = self.uc.emu_start(faddr, RET_MAGIC) {
			let pc = self.uc.reg_read(REG_PC);
			let lr = self.uc.reg_read(REG_LR);
			let x8 = self.uc.reg_read(REG_X0 + 8);
			let x9 = self.uc.reg_read(REG_X0 + 9);
			let code = self.uc.mem_read(pc, 8);
			return Err(format!(
				"{e} pc=0x{pc:x} lr=0x{lr:x} x8=0x{x8:x} x9=0x{x9:x} bytes={code:02x?}"
			));
		}
		Ok(self.uc.reg_read(REG_X0))
	}

	/// 在仿真堆上分配一块并写入。
	///
	/// 越界返回错误而不是 panic：panic 会毒化 Mutex，之后整个进程都用不了引擎。
	fn alloc(&self, buf: &[u8]) -> Result<u64, String> {
		let size = ((buf.len() + 15) & !15) as u64 + 16;
		let p = ALLOC_NEXT.fetch_add(size, Ordering::Relaxed);
		if p + size > SCRATCH_END {
			return Err(format!(
				"仿真堆耗尽：需要 {size} 字节，游标已到 0x{p:x}"
			));
		}
		self.uc.mem_write(p, buf);
		Ok(p)
	}

	fn write_u64(&self, addr: u64, v: u64) {
		self.uc.mem_write(addr, &v.to_le_bytes());
	}

	fn read_u64(&self, addr: u64) -> u64 {
		u64::from_le_bytes(self.uc.mem_read(addr, 8).try_into().unwrap())
	}

	fn read_vec(&self, addr: u64, len: usize) -> Vec<u8> {
		self.uc.mem_read(addr, len)
	}
}


/// 仿真加密器：单实例 + Mutex（unicorn 引擎不可重入）。
/// unicorn 句柄本身非线程安全，但所有访问都经 Mutex 串行化，跨线程移动安全。
unsafe impl Send for AnimeCrypto {}
pub struct AnimeCrypto {
	engine: Mutex<Engine>,
}

struct Engine {
	m: Machine,
	out_pp: u64,
	out_lp: u64,
}

/// 伪随机（信封 padding 用）：进程启动时以系统时间播种的 xorshift64。

impl AnimeCrypto {
	/// 加载 unicorn DLL 与参考 .so，注册算法表（进程内一次）。
	/// DLL 路径由调用方解析（打包后在资源目录 resources/anime/ 下）。
	pub fn new(unicorn_dll: &std::path::Path, cipher_so: &std::path::Path) -> Result<Self, String> {
		let so = std::fs::read(cipher_so)
			.map_err(|e| format!("读取 libmagic_cipher.so 失败：{e}"))?;
		let m = Machine::load(&so, unicorn_dll)?;
		// init：ids=算法 id，按注册顺序 MagicXOR/RC4/Base64/TEA/ChaCha20/Blowfish。
		// 算法 id = XOR(SHA256("EncryptionSDK.<算法名>.<轮密钥长度>"))。
		// ⚠️ 第 5 个（MagicChaCha20，轮密钥 44）的 id 是 0x3b，不是 0x8f——
		// 之前这里写错成 0x8f，导致信封头派生值对不上、服务器判定会话无效，
		// 业务请求一律 4020「加密会话过期」。已用 smali 打日志拿到真实算法名验证。
		let ids: &[u8] = &[0xe4, 0x19, 0x82, 0x9a, 0x3b, 0x75];
		let weights: &[u8] = &[1, 2, 3, 4, 5, 6];
		let mut shorts = Vec::new();
		for v in [8u16, 16, 0, 16, 44, 16] {
			shorts.extend_from_slice(&v.to_le_bytes());
		}
		let id_p = m.alloc(ids)?;
		let w_p = m.alloc(weights)?;
		let s_p = m.alloc(&shorts)?;
		let m1p = m.alloc(b"wire-code-mask")?;
		let m2p = m.alloc(b"payload-integrity")?;
		let rc = m.call_raw(BASE + 0x17720, &[id_p, w_p, s_p, 6, m1p, 14, m2p, 17]);
		if rc != Ok(0) {
			return Err(format!("加密引擎 init 失败：{rc:?}"));
		}
		// 播种伪随机
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_nanos() as u64)
			.unwrap_or(0x0123_4567_89ab_cdef);
		let _ = RAND_STATE.lock().map(|mut s| *s = nanos | 1);
		INITED.store(true, Ordering::Relaxed);
		Ok(Self {
			engine: Mutex::new(Engine { m, out_pp: SCRATCH, out_lp: SCRATCH + 8 }),
		})
	}

	/// v3 加密：`secret_ascii` = deviceSecret 的 ASCII64 hex 字符串字节。
	pub fn encrypt(
		&self,
		secret_ascii: &[u8],
		plain: &[u8],
		time_s: u64,
	) -> Result<Vec<u8>, String> {
		let engine = self.engine.lock().map_err(|_| "加密引擎锁中毒")?;
		// 每次调用复位仿真堆：游标只增不减会在长时间使用后越界
		reset_alloc();
		let m = &engine.m;
		let sp = m.alloc(secret_ascii)?;
		let pp = m.alloc(plain)?;
		m.write_u64(engine.out_pp, 0);
		m.write_u64(engine.out_lp, 0);
		let rc = m.call_raw(
			BASE + 0x180f8,
			&[sp, secret_ascii.len() as u64, pp, plain.len() as u64, time_s, 0, engine.out_pp, engine.out_lp],
		);
		take_output(m, &engine, rc)
	}

	/// v3 解密：`secret_ascii` 同上；失败返回错误文本（含引擎 rc）。
	pub fn decrypt(&self, secret_ascii: &[u8], cipher: &[u8]) -> Result<Vec<u8>, String> {
		let engine = self.engine.lock().map_err(|_| "加密引擎锁中毒")?;
		reset_alloc();
		let m = &engine.m;
		let sp = m.alloc(secret_ascii)?;
		let cp = m.alloc(cipher)?;
		m.write_u64(engine.out_pp, 0);
		m.write_u64(engine.out_lp, 0);
		let rc = m.call_raw(
			BASE + 0x1c930,
			&[sp, secret_ascii.len() as u64, cp, cipher.len() as u64, engine.out_pp, engine.out_lp],
		);
		take_output(m, &engine, rc)
	}
}

/// 读取引擎输出缓冲；rc != 0 或长度异常都报错。
fn take_output(
	m: &Machine,
	engine: &Engine,
	rc: Result<u64, String>,
) -> Result<Vec<u8>, String> {
	let rc_val = rc.map_err(|e| format!("引擎执行失败：{e}"))?;
	let ptr = m.read_u64(engine.out_pp);
	let len = m.read_u64(engine.out_lp);
	if len == 0 || len > 0x100_0000 {
		return Err(format!("引擎无输出（rc={rc_val}，len={len}）"));
	}
	Ok(m.read_vec(ptr, len as usize))
}

#[cfg(test)]
#[path = "../tests/unit/anime_crypto.rs"]
mod tests;

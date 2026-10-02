// 下载管理策略（架构文档 11.2 下载管理 + Phase 2『下载可追踪、可取消、可限制』
// 纯函数部分）：下载请求进入宿主前先经本模块裁决——文件名清洗（防路径穿越）、
// 扩展名白名单、MIME 前缀白名单、大小上限、同源检查；放行时生成任务隔离的
// 相对路径与可追踪 downloadId。本模块是纯函数：相同输入产出相同裁决，不含
// 任何 I/O，取消/进度等宿主侧行为由调用方基于 downloadId 实现。
// — English: download management policy (architecture §11.2 + Phase 2
//   "downloads trackable, cancellable, rate-limited" pure-function part) —
//   every download request is adjudicated before reaching the host: filename
//   sanitization (path-traversal defense), extension whitelist, MIME prefix
//   whitelist, size cap, same-origin check; on allow it yields a task-isolated
//   relative path and a traceable downloadId. Pure functions: same input,
//   same verdict, no I/O; cancellation/progress live on the host side and key
//   off the downloadId.
import { stripUrlUserInfo } from './urlSafe.js';
// 注：@suanlizi/protocol 暂无下载规格类型，本模块类型均按架构文档 11.2 本地定义。
// — English: note — @suanlizi/protocol has no download-spec type yet; all types
//   below are defined locally per architecture §11.2.

// 下载规格：URL 与服务器声明字段均视为不可信输入，仅作策略上下文。
// — English: download spec — URL and server-declared fields are untrusted
//   input used only as policy context.
export interface DownloadSpec {
  url: string; // 下载来源 URL（download source URL）
  suggestedName: string; // Content-Disposition 或 URL 文件名（不可信输入；untrusted）
  mimeType?: string; // 服务器声明（不可信；untrusted）
  sizeBytes?: number; // Content-Length（可能未知；may be unknown）
  sourceOrigin: string; // 触发下载的页面 origin（策略上下文；policy context）
}

// 下载策略配置：全部字段可选，缺省时合并 DEFAULT_DOWNLOAD_POLICY。
// — English: download policy config — all fields optional; missing fields
//   fall back to DEFAULT_DOWNLOAD_POLICY.
export interface DownloadPolicyConfig {
  maxBytes?: number; // 默认 50 * 1024 * 1024
  allowedExtensions?: string[]; // 默认 ['pdf','txt','md','json','csv','zip']
  allowedMimePrefixes?: string[]; // 默认 ['text/','application/pdf','application/json','application/zip','image/']
  allowUnknownMime?: boolean; // 默认 true（无 MIME 时不因未知拒绝，仅警告）
}

// 裁决结果：allow 携带隔离目录相对路径与 downloadId；deny 携带人类可读原因
// 与稳定错误码（供宿主记录与上报）。
// — English: verdict — allow carries the isolated relative path and a
//   downloadId; deny carries a human-readable reason and a stable error code.
export type DownloadVerdict =
  | { kind: 'allow'; downloadId: string; fileName: string; relativePath: string; note?: string }
  | { kind: 'deny'; reason: string; code: 'NAME_INVALID' | 'SIZE_LIMIT' | 'TYPE_BLOCKED' | 'ORIGIN_BLOCKED' };

// 默认策略：50MiB 上限；常见文档/数据/压缩与图片类型。
// — English: default policy — 50 MiB cap; common document/data/archive/image
//   types.
export const DEFAULT_DOWNLOAD_POLICY: Required<DownloadPolicyConfig> = {
  maxBytes: 50 * 1024 * 1024,
  allowedExtensions: ['pdf', 'txt', 'md', 'json', 'csv', 'zip'],
  allowedMimePrefixes: ['text/', 'application/pdf', 'application/json', 'application/zip', 'image/'],
  allowUnknownMime: true,
};

// downloadId 随机段字符集：小写字母 + 数字（36 进制友好，日志可读）。
// — English: charset for the random token of downloadId — lowercase
//   alphanumerics (base36-friendly, log-readable).
const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// 生成 length 位小写字母数字随机串（非密码用途，仅用于 id 消歧）。
// — English: random lowercase-alphanumeric token of the given length
//   (not for security, only id disambiguation).
function randomToken(length: number): string {
  let token = '';
  for (let i = 0; i < length; i++) {
    token += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
  }
  return token;
}

// 文件名清洗：去目录部分（按 \\ / 切分取末段）、移除所有 '..'、剔除控制字符
// （\x00-\x1f）、去首尾空白；空结果回退 'download.bin'；截断到 120 字符。
// 返回纯文件名，绝不含路径分隔符或 '..'。
// — English: filename sanitization — strip directory parts (take the last
//   segment split by \\ /), remove every '..', drop control chars
//   (\x00-\x1f), trim whitespace; empty result falls back to 'download.bin';
//   truncate to 120 chars. Returns a bare filename, never containing a path
//   separator or '..'.
export function normalizeDownloadName(raw: string): string {
  // 目录部分剥离：'../../etc/passwd'、'a\\b\\c.txt' → 纯文件名。
  // — English: strip directory part — yields the bare filename.
  let name = raw.split(/[\\/]/).pop() ?? '';
  // 路径穿越片段兜底：即使无分隔符的 '..' 也整体移除。
  // — English: belt-and-braces removal of any remaining '..' segments.
  name = name.replace(/\.\./g, '');
  // 控制字符（含 \n \r \t）不可进入文件名。
  // — English: control characters must not enter filenames.
  name = name.replace(/[\x00-\x1f]/g, '');
  name = name.trim();
  if (name === '') {
    return 'download.bin';
  }
  return name.length > 120 ? name.slice(0, 120) : name;
}

// 扩展名提取：最后一个 '.' 之后的小写；无 '.' 或 '.' 后为空 → ''（无扩展名）。
// — English: extension extraction — lowercase text after the last dot; '' when
//   there is no dot or nothing follows it.
function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0 || idx === fileName.length - 1) {
    return '';
  }
  return fileName.slice(idx + 1).toLowerCase();
}

// MIME 规范化：去参数（';' 之前）、去空白、小写；空/缺失 → null。
// — English: MIME normalization — strip parameters (before ';'), trim,
//   lowercase; missing/blank → null.
function normalizeMime(mimeType: string | undefined): string | null {
  if (mimeType === undefined) {
    return null;
  }
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === '' ? null : mime;
}

// 无扩展名时按 MIME 推断扩展名；无对应映射 → null（不因扩展名拒绝，见裁决）。
// — English: infer an extension from the MIME type when the filename has none;
//   no mapping → null (the extension check alone never rejects then).
function inferExtension(mimeType: string | undefined): string | null {
  const mime = normalizeMime(mimeType);
  if (mime === null) {
    return null;
  }
  if (mime === 'text/plain') return 'txt';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/json') return 'json';
  if (mime === 'application/zip') return 'zip';
  if (mime.startsWith('image/')) return 'png';
  return null;
}

// 下载裁决：规则按序执行，全部通过才 allow——
// 1. 同源检查（URL 解析失败按跨域拒绝）；
// 2. 扩展名白名单（无扩展名时按 MIME 推断，仍无则不因扩展名拒绝并附 note）；
// 3. 大小上限；
// 4. MIME 前缀白名单（无 MIME 且 allowUnknownMime=false 时拒绝）；
// 5. 放行：生成 downloadId 与任务隔离相对路径 downloads/<id>/<file>。
// — English: download verdict — rules run in order; allow only when all pass:
//   1. same-origin check (unparseable URL counts as cross-origin);
//   2. extension whitelist (infer from MIME when missing; still missing → no
//      rejection on this rule, note attached);
//   3. size cap;
//   4. MIME prefix whitelist (no MIME + allowUnknownMime=false → reject);
//   5. allow: downloadId and task-isolated relative path downloads/<id>/<file>.
export function evaluateDownload(spec: DownloadSpec, config?: DownloadPolicyConfig): DownloadVerdict {
  const cfg: Required<DownloadPolicyConfig> = { ...DEFAULT_DOWNLOAD_POLICY, ...config };

  // 规则 1：同源检查。new URL 解析失败（非法/相对 URL）→ 视为跨域拒绝。
  // — English: rule 1 — same-origin check; unparseable URL counts as
  //   cross-origin and is denied.
  let urlOrigin: string;
  try {
    urlOrigin = new URL(spec.url).origin;
  } catch {
    // 错误信息不回显原始 URL（可能含 userinfo 凭据）。
    // — English: the raw URL (which may carry userinfo credentials) is never
    //   echoed back into the denial message.
    return { kind: 'deny', reason: '无法解析下载 URL（视为跨域）', code: 'ORIGIN_BLOCKED' };
  }
  if (urlOrigin !== spec.sourceOrigin) {
    return {
      kind: 'deny',
      reason: `跨域下载需授权: ${stripUrlUserInfo(spec.url)}`,
      code: 'ORIGIN_BLOCKED',
    };
  }

  // 规则 2：文件名清洗与扩展名白名单。
  // — English: rule 2 — sanitized filename and extension whitelist.
  let fileName = normalizeDownloadName(spec.suggestedName);
  const ext = extensionOf(fileName);
  let note: string | undefined;
  if (ext === '') {
    // 无扩展名：按 MIME 推断；仍无 → 不因扩展名拒绝，放行时附 note。
    // — English: no extension — infer from MIME; still none → the extension
    //   rule alone does not reject; a note is attached on allow.
    const inferred = inferExtension(spec.mimeType);
    if (inferred !== null) {
      fileName = `${fileName}.${inferred}`;
    } else {
      note = 'extension inferred from mime';
    }
  } else if (!cfg.allowedExtensions.includes(ext)) {
    return {
      kind: 'deny',
      reason: `扩展名 .${ext} 不在白名单: ${cfg.allowedExtensions.join(', ')}`,
      code: 'TYPE_BLOCKED',
    };
  }

  // 规则 3：大小上限（sizeBytes 未知时不限制）。
  // — English: rule 3 — size cap (unknown sizeBytes is not limited).
  if (spec.sizeBytes !== undefined && spec.sizeBytes > cfg.maxBytes) {
    return {
      kind: 'deny',
      reason: `文件大小 ${spec.sizeBytes} 字节超过上限 ${cfg.maxBytes} 字节`,
      code: 'SIZE_LIMIT',
    };
  }

  // 规则 4：MIME 前缀白名单；无 MIME 时取决于 allowUnknownMime。
  // — English: rule 4 — MIME prefix whitelist; absent MIME depends on
  //   allowUnknownMime.
  const mime = normalizeMime(spec.mimeType);
  if (mime !== null) {
    if (!cfg.allowedMimePrefixes.some((prefix) => mime.startsWith(prefix))) {
      return { kind: 'deny', reason: `MIME 类型 ${mime} 不在白名单`, code: 'TYPE_BLOCKED' };
    }
  } else if (!cfg.allowUnknownMime) {
    return { kind: 'deny', reason: '未知 MIME 类型且 allowUnknownMime=false', code: 'TYPE_BLOCKED' };
  }

  // 规则 5：放行——downloadId（时间戳 36 进制 + 4 位随机）与任务隔离相对路径。
  // — English: rule 5 — allow — downloadId (base36 timestamp + 4 random
  //   chars) and the task-isolated relative path.
  const downloadId = `dl-${Date.now().toString(36)}-${randomToken(4)}`;
  const relativePath = `downloads/${downloadId}/${fileName}`;
  if (note !== undefined) {
    return { kind: 'allow', downloadId, fileName, relativePath, note };
  }
  return { kind: 'allow', downloadId, fileName, relativePath };
}

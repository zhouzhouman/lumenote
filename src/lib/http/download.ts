/**
 * 下载响应头里的文件名编码。
 *
 * ## 为什么需要一个专门的函数
 *
 * HTTP 头只能是 **ByteString（≤ 0xFF 的字符）**。把中文直接拼进
 * `Content-Disposition: attachment; filename="批次.csv"` 会在运行时抛
 *
 *   TypeError: Cannot convert argument to a ByteString because the character
 *   at index N has a value of 25209 which is greater than 255
 *
 * 而且这个错误发生在**返回响应对象的那一刻**，路由的 try/catch 捕获不到有效信息，
 * 用户看到的是 500「服务内部错误」——明明只是导出，却像是系统坏了。
 *
 * 正确做法是 RFC 6266 / RFC 5987 的组合：
 *   - `filename=`   放一个 ASCII 兜底名（老客户端用）
 *   - `filename*=`  放 UTF-8 percent-encoded 的真实名字（现代浏览器优先用它）
 */

/** 把任意字符串压成可安全放进 HTTP 头的 ASCII 文件名主体 */
export function asciiFilename(name: string): string {
  const cleaned = name
    // 非 ASCII 统一替换成下划线，避免出现「批次_」这种断裂感
    .replace(/[^\x20-\x7E]/g, '_')
    // 引号与反斜杠会破坏 header 语法
    .replace(/["\\]/g, '_')
    // 连续的替代符压成一个，避免 a____b
    .replace(/_{2,}/g, '_')
    .trim();
  // 全是下划线（原名字全是非 ASCII）时也别给用户一个「_.csv」，用通用名
  if (!cleaned || /^_+$/.test(cleaned)) return 'download';
  return cleaned;
}

/**
 * 生成 Content-Disposition 头（含 ASCII 兜底 + UTF-8 编码的真实名）。
 *
 * @param filename 真实文件名（可含中文），已含扩展名
 */
export function contentDisposition(filename: string): string {
  const ascii = asciiFilename(filename);
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

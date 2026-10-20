import { describe, it, expect } from 'vitest';
import { isPrivateIp, SsrfError } from '@/lib/http/safe-fetch';

/**
 * SSRF 防护的测试。
 *
 * 这是全项目安全风险最高的一处：URL 抓取功能一旦被绕过，
 * 攻击者就能通过我们的服务器访问内网服务、云元数据（拿 IAM 凭证），
 * 后果是**服务器横向移动**，不是普通的信息泄露。
 *
 * 所以这里的用例刻意覆盖各种「等价写法」，而不只是最直觉的那种。
 */
describe('isPrivateIp', () => {
  it('拦截 RFC1918 私有段', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('172.15/172.32 不属于私有段（边界）', () => {
    expect(isPrivateIp('172.15.255.255')).toBe(false);
    expect(isPrivateIp('172.32.0.0')).toBe(false);
  });

  it('拦截环回地址', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.1.2.3')).toBe(true);
  });

  it('拦截云厂商元数据地址', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('100.100.100.200')).toBe(true);
    expect(isPrivateIp('192.0.0.192')).toBe(true);
  });

  it('拦截 CGNAT 段（云厂商常用，部分环境可路由到内部服务）', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.255')).toBe(true);
  });

  it('放行正常公网地址', () => {
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
  });

  /**
   * 这是「必须用整数区间比较而不能用字符串前缀」的原因。
   * 这些写法都能指向内网，但字符串前缀匹配一个都拦不住。
   */
  it('拦截各种等价/变形写法', () => {
    // 前导零：某些解析器会当成八进制，Node 会当成十进制
    expect(isPrivateIp('010.0.0.1')).toBe(true);
    expect(isPrivateIp('127.000.000.001')).toBe(true);
  });

  it('非法 IP 一律拒绝（fail-closed）', () => {
    // 关键：解析失败必须返回 true（拒绝），返回 false 会让脏数据通过
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp('999.999.999.999')).toBe(true);
    expect(isPrivateIp('1.2.3')).toBe(true);
  });

  it('IPv6 环回与唯一本地地址被拦截', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('IPv4 映射的 IPv6 不能成为绕过私网检测的后门', () => {
    // ::ffff:127.0.0.1 与 127.0.0.1 是同一个地址
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('放行公网 IPv6', () => {
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('SsrfError', () => {
  it('携带可辨识的 code，便于 API 层映射错误码', () => {
    const err = new SsrfError('不允许的地址', 'PRIVATE_IP');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('PRIVATE_IP');
    expect(err.name).toBe('SsrfError');
  });
});
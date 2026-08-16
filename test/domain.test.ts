import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  perTokenToPerMillion,
  ratioToPerMillion,
  ratioToPerCall,
  roundUsd,
  normalizeBaseUrl,
  providerSlug,
} from '../src/domain.js';

test('每 token 字符串价格换算为每百万美元', () => {
  assert.equal(perTokenToPerMillion('0.00000056'), 0.56);
  assert.equal(perTokenToPerMillion('$0.00003'), 30);
  assert.equal(perTokenToPerMillion('0.00006'), 60);
  assert.equal(perTokenToPerMillion('0'), 0);
  // 低于 1e-6 USD/1M 精度的极小值按 6 位小数舍入为 0
  assert.equal(perTokenToPerMillion('0.000000000000001'), 0);
});

test('每 token 数字价格换算为每百万美元', () => {
  assert.equal(perTokenToPerMillion(5e-7), 0.5);
  assert.equal(perTokenToPerMillion(1.5e-7), 0.15);
  assert.equal(perTokenToPerMillion(0), 0);
});

test('非法价格输入返回 null', () => {
  assert.equal(perTokenToPerMillion('abc'), null);
  assert.equal(perTokenToPerMillion('-1'), null);
  assert.equal(perTokenToPerMillion(''), null);
  assert.equal(perTokenToPerMillion('  '), null);
  assert.equal(perTokenToPerMillion(Number.NaN), null);
  assert.equal(perTokenToPerMillion(Number.POSITIVE_INFINITY), null);
  assert.equal(perTokenToPerMillion(-5), null);
  // 科学计数法/十六进制等畸形字符串拒绝（仅接受十进制数字）
  assert.equal(perTokenToPerMillion('1e-7'), null);
  assert.equal(perTokenToPerMillion('0x10'), null);
  assert.equal(perTokenToPerMillion('1,5'), null);
});

test('换算溢出返回 null 而非 Infinity', () => {
  assert.equal(perTokenToPerMillion(Number.MAX_VALUE), null);
  assert.deepEqual(ratioToPerMillion(Number.MAX_VALUE, 1, 1), { input: null, output: null });
  assert.equal(ratioToPerCall(Number.MAX_VALUE, 2), null);
  // 309 位十进制数超出 Number 上限（转 Infinity），应判非法
  assert.equal(perTokenToPerMillion('9'.repeat(309)), null);
});

test('roundUsd 六位小数舍入', () => {
  assert.equal(roundUsd(0.5599999999999999), 0.56);
  assert.equal(roundUsd(0.12345678), 0.123457);
});

test('倍率计价换算：基础值 2 美元/百万 token', () => {
  assert.deepEqual(ratioToPerMillion(1, undefined, undefined), { input: 2, output: 2 });
  assert.deepEqual(ratioToPerMillion(0.5, 2, 1.5), { input: 1.5, output: 3 });
  assert.deepEqual(ratioToPerMillion(2, 1, 0.5), { input: 2, output: 2 });
});

test('倍率计价非法输入返回 null', () => {
  assert.deepEqual(ratioToPerMillion(-1, 1, 1), { input: null, output: null });
  assert.deepEqual(ratioToPerMillion(1, -1, 1), { input: null, output: null });
  assert.deepEqual(ratioToPerMillion(1, 1, Number.NaN), { input: null, output: null });
  assert.deepEqual(ratioToPerMillion(Number.POSITIVE_INFINITY, 1, 1), { input: null, output: null });
});

test('按次计价换算', () => {
  assert.equal(ratioToPerCall(0.05, 2), 0.1);
  assert.equal(ratioToPerCall(0.05, undefined), 0.05);
  assert.equal(ratioToPerCall(-1, 1), null);
  assert.equal(ratioToPerCall(1, Number.NaN), null);
});

test('baseUrl 规整：去尾部斜杠与 /v1 后缀', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(normalizeBaseUrl('  https://h.example.com  '), 'https://h.example.com');
  assert.throws(() => normalizeBaseUrl('api.example.com'));
});

test('provider 标识由主机名推断', () => {
  assert.equal(providerSlug('https://api.deepseek.com'), 'deepseek');
  assert.equal(providerSlug('http://localhost:11434'), 'local');
  assert.equal(providerSlug('http://192.168.1.5:8000'), 'local');
  assert.equal(providerSlug('https://gate.example.net'), 'example');
  assert.equal(providerSlug('http://127.0.0.1:8000'), 'local');
});

test('normalizeBaseUrl：双重斜杠 + /v1 组合不留尾斜杠，大小写不敏感', () => {
  assert.equal(normalizeBaseUrl('https://h.example.com//v1'), 'https://h.example.com');
  assert.equal(normalizeBaseUrl('https://h.example.com//v1//'), 'https://h.example.com');
  assert.equal(normalizeBaseUrl('https://h.example.com/V1'), 'https://h.example.com');
  assert.equal(normalizeBaseUrl('https://h.example.com'), 'https://h.example.com');
});

test('provider 标识：IPv6 回环与多级子域名', () => {
  assert.equal(providerSlug('http://[::1]:11434'), 'local');
  assert.equal(providerSlug('http://10.0.0.8:8080'), 'local');
  assert.equal(providerSlug('https://api.cn.example.com/v1'), 'example');
  assert.equal(providerSlug('not a url'), 'unknown');
});

test('每 token 价格的十进制变形输入', () => {
  assert.equal(perTokenToPerMillion('00.5'), 500000);
  assert.equal(perTokenToPerMillion('¥0.001'), 1000);
  assert.equal(perTokenToPerMillion('  $0.00003  '), 30);
});

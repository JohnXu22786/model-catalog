import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettingsFile, resolveApiKey, resolveApiKeyEnvName, DEFAULT_SETTINGS } from '../src/config/settings.js';

function writeConfig(dir: string, content: string): string {
  const file = join(dir, 'catalog.config.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

test('配置文件解析：合法字段生效，非法字段忽略', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    const file = writeConfig(
      dir,
      JSON.stringify({
        baseUrl: 'https://api.example.com',
        probe: 'never',
        catalogTtlSec: 123,
        concurrency: 8,
        apiKeyEnv: 'MY_KEY',
        kindHint: 'quota',
      }),
    );
    const s = await loadSettingsFile(file);
    assert.equal(s.baseUrl, 'https://api.example.com');
    assert.equal(s.probe, 'never');
    assert.equal(s.catalogTtlSec, 123);
    assert.equal(s.concurrency, 8);
    assert.equal(s.apiKeyEnv, 'MY_KEY');
    assert.equal(s.kindHint, 'quota');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置文件解析：非法枚举与非法类型被忽略', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    const file = writeConfig(
      dir,
      JSON.stringify({ probe: 'sometimes', catalogTtlSec: '900', kindHint: 'bogus-kind', baseUrl: '   ' }),
    );
    const s = await loadSettingsFile(file);
    assert.equal(s.probe, undefined, '非法探测模式忽略');
    assert.equal(s.catalogTtlSec, undefined, '非数字忽略');
    assert.equal(s.kindHint, undefined, '非法主机类型忽略');
    assert.equal(s.baseUrl, undefined, '空白 baseUrl 忽略');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置文件不存在时返回空配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  try {
    const s = await loadSettingsFile(join(dir, 'missing.json'));
    assert.deepEqual(s, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('密钥环境变量：显式指定优先于自动探测链', async () => {
  const saved: Record<string, string | undefined> = {};
  const names = ['MODELCAT_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'];
  for (const n of names) saved[n] = process.env[n];
  try {
    for (const n of names) delete process.env[n];
    assert.equal(resolveApiKeyEnvName(DEFAULT_SETTINGS), null);

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    assert.equal(resolveApiKeyEnvName(DEFAULT_SETTINGS), 'DEEPSEEK_API_KEY', '自动探测链命中');
    assert.equal(resolveApiKey(DEFAULT_SETTINGS), 'ds-key');

    process.env.OPENAI_API_KEY = 'oa-key';
    assert.equal(resolveApiKeyEnvName(DEFAULT_SETTINGS), 'DEEPSEEK_API_KEY', '探测链按顺序优先');

    assert.equal(resolveApiKeyEnvName({ ...DEFAULT_SETTINGS, apiKeyEnv: 'MY_KEY' }), 'MY_KEY', '显式指定优先');
    assert.equal(resolveApiKey({ ...DEFAULT_SETTINGS, apiKeyEnv: 'MY_KEY' }), null, '变量未设置时返回 null');

    process.env.MODELCAT_API_KEY = '';
    assert.equal(resolveApiKeyEnvName(DEFAULT_SETTINGS), 'DEEPSEEK_API_KEY', '空字符串不算有效密钥');
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

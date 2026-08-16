import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/storage/vault.js';

function makeVault(nowFn: () => number, opts: { lockStaleMs?: number; lockWaitMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-test-'));
  const vault = new Vault(dir, { now: nowFn, ...opts });
  return { dir, vault };
}

test('写入与读取往返，TTL 控制过期', async () => {
  const t = { n: 1000 };
  const { vault, dir } = makeVault(() => t.n);
  await vault.init();
  vault.write('k1', { x: 1 });
  assert.deepEqual(vault.read('k1'), { x: 1 });
  assert.deepEqual(vault.read('k1', 600), { x: 1 });
  t.n += 1001;
  assert.equal(vault.read('k1', 600), null);
  // 无 TTL 时永不失效
  assert.deepEqual(vault.read('k1'), { x: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test('持久化到磁盘且可重载', async () => {
  const t = { n: 0 };
  const { vault, dir } = makeVault(() => t.n);
  await vault.init();
  vault.write('a', { v: 42 });
  const again = new Vault(dir, { now: () => 0 });
  await again.init();
  assert.deepEqual(again.read('a'), { v: 42 });
  rmSync(dir, { recursive: true, force: true });
});

test('损坏的缓存文件被重置而不抛错', async () => {
  const t = { n: 0 };
  const { vault, dir } = makeVault(() => t.n);
  writeFileSync(join(dir, 'vault.json'), '{"broken": tru', 'utf8');
  await vault.init();
  assert.equal(vault.read('x'), null);
  vault.write('y', 1);
  assert.equal(vault.read('y'), 1);
  rmSync(dir, { recursive: true, force: true });
});

test('锁：过期锁（陈旧）可接管', async () => {
  const t = { n: 5_000_000 };
  const { vault, dir } = makeVault(() => t.n, { lockStaleMs: 1000, lockWaitMs: 200 });
  await vault.init();
  // 手工制造一个"陈旧"的锁文件（超过锁过期时间）
  const lockPath = join(dir, '.lock');
  writeFileSync(lockPath, '{}', 'utf8');
  utimesSync(lockPath, new Date(t.n - 5000), new Date(t.n - 5000));
  let entered = false;
  await vault.withLock(async () => {
    entered = true;
  });
  assert.equal(entered, true);
  rmSync(dir, { recursive: true, force: true });
});

test('锁：新鲜锁会导致等待超时', async () => {
  const t = { n: 1_000_000 };
  const { vault, dir } = makeVault(() => t.n, { lockStaleMs: 1000, lockWaitMs: 150 });
  await vault.init();
  const lockPath = join(dir, '.lock');
  writeFileSync(lockPath, '{}', 'utf8');
  utimesSync(lockPath, new Date(t.n), new Date(t.n));
  await assert.rejects(() => vault.withLock(async () => {}), /锁/);
  rmSync(dir, { recursive: true, force: true });
});

test('锁：释放后他人可获取', async () => {
  const t = { n: 0 };
  const { vault, dir } = makeVault(() => t.n);
  await vault.init();
  await vault.withLock(async () => {});
  assert.equal(existsSync(join(dir, '.lock')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('clear 清空全部条目', async () => {
  const { vault, dir } = makeVault(() => 0);
  await vault.init();
  vault.write('a', 1);
  vault.write('b', 2);
  await vault.clear();
  assert.equal(vault.read('a'), null);
  assert.equal(vault.read('b'), null);
  rmSync(dir, { recursive: true, force: true });
});

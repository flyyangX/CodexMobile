import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAgentLarkConfigDir } from './lark-cli.js';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function makeTempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-lark-config-'));
}

test('prepareAgentLarkConfigDir supports flat lark-cli config directories', async () => {
  const root = await makeTempRoot();
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');

  await fs.mkdir(path.join(sourceRoot, 'cache'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'locks'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'logs'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'config.json'), '{"layout":"flat"}\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'skills.stamp'), 'ok\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'cache', 'skip.txt'), 'cached\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'logs', 'skip.txt'), 'logged\n', 'utf8');

  const configRoot = await prepareAgentLarkConfigDir({ sourceRoot, targetRoot });

  assert.equal(configRoot, targetRoot);
  assert.equal(await fs.readFile(path.join(targetRoot, 'config.json'), 'utf8'), '{"layout":"flat"}\n');
  assert.equal(await fs.readFile(path.join(targetRoot, 'openclaw', 'config.json'), 'utf8'), '{"layout":"flat"}\n');
  assert.equal(await exists(path.join(targetRoot, 'cache')), true);
  assert.equal(await exists(path.join(targetRoot, 'openclaw', 'cache')), true);
  assert.equal(await exists(path.join(targetRoot, 'cache', 'skip.txt')), false);
  assert.equal(await exists(path.join(targetRoot, 'openclaw', 'logs', 'skip.txt')), false);
});

test('prepareAgentLarkConfigDir keeps profile layout when openclaw exists', async () => {
  const root = await makeTempRoot();
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  const sourceProfile = path.join(sourceRoot, 'openclaw');

  await fs.mkdir(path.join(sourceProfile, 'cache'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'config.json'), '{"layout":"root"}\n', 'utf8');
  await fs.writeFile(path.join(sourceProfile, 'config.json'), '{"layout":"profile"}\n', 'utf8');
  await fs.writeFile(path.join(sourceProfile, 'cache', 'skip.txt'), 'cached\n', 'utf8');

  const configRoot = await prepareAgentLarkConfigDir({ sourceRoot, targetRoot });

  assert.equal(configRoot, targetRoot);
  assert.equal(await fs.readFile(path.join(targetRoot, 'openclaw', 'config.json'), 'utf8'), '{"layout":"profile"}\n');
  assert.equal(await exists(path.join(targetRoot, 'config.json')), false);
  assert.equal(await exists(path.join(targetRoot, 'openclaw', 'cache')), true);
  assert.equal(await exists(path.join(targetRoot, 'openclaw', 'cache', 'skip.txt')), false);
});

test('prepareAgentLarkConfigDir resets stale target content between layouts', async () => {
  const root = await makeTempRoot();
  const flatSource = path.join(root, 'flat-source');
  const profileSource = path.join(root, 'profile-source');
  const targetRoot = path.join(root, 'target');

  await fs.mkdir(flatSource, { recursive: true });
  await fs.writeFile(path.join(flatSource, 'config.json'), '{"layout":"flat"}\n', 'utf8');
  await prepareAgentLarkConfigDir({ sourceRoot: flatSource, targetRoot });
  await fs.writeFile(path.join(targetRoot, 'obsolete.json'), '{"stale":true}\n', 'utf8');
  await fs.writeFile(path.join(targetRoot, 'cache', 'stale.txt'), 'stale cache\n', 'utf8');
  await fs.writeFile(path.join(targetRoot, 'openclaw', 'logs', 'stale.txt'), 'stale log\n', 'utf8');

  await fs.mkdir(path.join(profileSource, 'openclaw'), { recursive: true });
  await fs.writeFile(path.join(profileSource, 'openclaw', 'config.json'), '{"layout":"profile"}\n', 'utf8');

  await prepareAgentLarkConfigDir({ sourceRoot: profileSource, targetRoot });

  assert.equal(await exists(path.join(targetRoot, 'config.json')), false);
  assert.equal(await exists(path.join(targetRoot, 'obsolete.json')), false);
  assert.equal(await exists(path.join(targetRoot, 'cache', 'stale.txt')), false);
  assert.equal(await exists(path.join(targetRoot, 'openclaw', 'logs', 'stale.txt')), false);
  assert.equal(await fs.readFile(path.join(targetRoot, 'openclaw', 'config.json'), 'utf8'), '{"layout":"profile"}\n');
});

test('prepareAgentLarkConfigDir ignores runtime-only openclaw when flat config exists', async () => {
  const root = await makeTempRoot();
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');

  await fs.mkdir(path.join(sourceRoot, 'openclaw', 'logs'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'config.json'), '{"layout":"flat"}\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'openclaw', 'logs', 'skip.txt'), 'logged\n', 'utf8');

  await prepareAgentLarkConfigDir({ sourceRoot, targetRoot });

  assert.equal(await fs.readFile(path.join(targetRoot, 'config.json'), 'utf8'), '{"layout":"flat"}\n');
  assert.equal(await fs.readFile(path.join(targetRoot, 'openclaw', 'config.json'), 'utf8'), '{"layout":"flat"}\n');
  assert.equal(await exists(path.join(targetRoot, 'openclaw', 'openclaw')), false);
  assert.equal(await exists(path.join(targetRoot, 'openclaw', 'logs', 'skip.txt')), false);
});

test('prepareAgentLarkConfigDir reports missing lark-cli config explicitly', async () => {
  const root = await makeTempRoot();
  const sourceRoot = path.join(root, 'missing');
  const targetRoot = path.join(root, 'target');

  await assert.rejects(
    prepareAgentLarkConfigDir({ sourceRoot, targetRoot }),
    /lark-cli 配置目录不存在/
  );
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStaticService } from './static-service.js';

function req(headers = {}) {
  return { headers };
}

function res() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    }
  };
}

async function withTempService(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-static-'));
  const clientDist = path.join(root, 'dist');
  const generatedRoot = path.join(root, 'generated');
  const uploadRoot = path.join(root, 'uploads');
  const desktopImageRoot = path.join(root, 'desktop-images');
  const certPath = path.join(root, 'tls', 'root.cer');
  await fs.mkdir(clientDist, { recursive: true });
  await fs.mkdir(generatedRoot, { recursive: true });
  await fs.mkdir(uploadRoot, { recursive: true });
  await fs.mkdir(desktopImageRoot, { recursive: true });
  await fs.mkdir(path.dirname(certPath), { recursive: true });
  await fs.writeFile(path.join(clientDist, 'index.html'), '<h1>CodexMobile</h1>');
  await fs.writeFile(path.join(clientDist, 'worker.mjs'), 'export default null;');
  await fs.writeFile(path.join(generatedRoot, 'image.png'), Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(path.join(uploadRoot, 'upload.png'), Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(path.join(desktopImageRoot, 'desktop.png'), Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(path.join(root, 'report.md'), '# Report');
  await fs.writeFile(path.join(root, 'brief.pdf'), Buffer.from('%PDF-1.7'));
  await fs.writeFile(path.join(root, '甘肃临夏萌宠乐园丨政府汇报项目前置简介.md'), '# 中文文件名');
  await fs.writeFile(path.join(root, 'secret.txt'), 'secret');
  await fs.writeFile(certPath, 'cert');
  try {
    await fn(createStaticService({ clientDist, generatedRoot, uploadRoot, desktopImageRoot, httpsRootCaPath: certPath }), {
      root,
      generatedRoot,
      uploadRoot,
      desktopImageRoot
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('serveStatic returns a normal PWA file', async () => {
  await withTempService(async (service) => {
    const response = res();
    await service.serveStatic(req(), response, new URL('http://local/'));

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.equal(response.body.toString('utf8'), '<h1>CodexMobile</h1>');
  });
});

test('serveStatic returns mjs files as JavaScript for module workers', async () => {
  await withTempService(async (service) => {
    const response = res();
    await service.serveStatic(req(), response, new URL('http://local/worker.mjs'));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
  });
});

test('serveStatic blocks traversal outside the PWA root', async () => {
  await withTempService(async (service) => {
    const response = res();
    await service.serveStatic(req(), response, new URL('http://local/..%2fsecret.txt'));

    assert.equal(response.statusCode, 403);
    assert.equal(response.body.toString('utf8'), 'Forbidden');
  });
});

test('serveStatic returns generated files from the generated root', async () => {
  await withTempService(async (service) => {
    const response = res();
    await service.serveStatic(req(), response, new URL('http://local/generated/image.png'));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.deepEqual([...response.body], [137, 80, 78, 71]);
  });
});

test('sendLocalFile serves markdown files inline from absolute paths', async () => {
  await withTempService(async (service, { root }) => {
    const filePath = path.join(root, 'report.md');
    const response = res();
    await service.sendLocalFile(req(), response, new URL(`http://local/api/local-file?path=${encodeURIComponent(filePath)}`));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.match(response.headers['content-disposition'], /^inline;/);
  });
});

test('sendLocalFile serves pdf files with pdf content type', async () => {
  await withTempService(async (service, { root }) => {
    const filePath = path.join(root, 'brief.pdf');
    const response = res();
    await service.sendLocalFile(req(), response, new URL(`http://local/api/local-file?path=${encodeURIComponent(filePath)}`));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/pdf');
    assert.match(response.headers['content-disposition'], /^inline;/);
  });
});

test('sendLocalFile tolerates Codex style line suffixes on file links', async () => {
  await withTempService(async (service, { root }) => {
    const filePath = `${path.join(root, 'report.md')}:12`;
    const response = res();
    await service.sendLocalFile(req(), response, new URL(`http://local/api/local-file?path=${encodeURIComponent(filePath)}`));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.equal(response.body.toString('utf8'), '# Report');
  });
});

test('sendLocalFile encodes non-ascii filenames in content-disposition', async () => {
  await withTempService(async (service, { root }) => {
    const filePath = path.join(root, '甘肃临夏萌宠乐园丨政府汇报项目前置简介.md');
    const response = res();
    await service.sendLocalFile(req(), response, new URL(`http://local/api/local-file?path=${encodeURIComponent(filePath)}`));

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-disposition'], /filename\*=UTF-8''/);
    assert.doesNotMatch(response.headers['content-disposition'], /[\u0080-\uFFFF]/);
    assert.equal(response.body.toString('utf8'), '# 中文文件名');
  });
});

test('writeLocalFile saves editable text files with conflict protection and backup', async () => {
  await withTempService(async (service, { root }) => {
    const filePath = path.join(root, 'report.md');
    const initialStat = await fs.stat(filePath);
    const saveResponse = res();
    await service.writeLocalFile(
      req(),
      saveResponse,
      new URL(`http://local/api/local-file?path=${encodeURIComponent(filePath)}`),
      { content: '# Updated', baseMtimeMs: Math.round(initialStat.mtimeMs) }
    );

    assert.equal(saveResponse.statusCode, 200);
    const payload = JSON.parse(saveResponse.body.toString('utf8'));
    assert.equal(payload.ok, true);
    assert.ok(payload.backupPath);
    assert.equal(await fs.readFile(filePath, 'utf8'), '# Updated');
    assert.equal(await fs.readFile(payload.backupPath, 'utf8'), '# Report');

    const conflictResponse = res();
    await service.writeLocalFile(
      req(),
      conflictResponse,
      new URL(`http://local/api/local-file?path=${encodeURIComponent(filePath)}`),
      { content: '# Stale', baseMtimeMs: 1 }
    );

    assert.equal(conflictResponse.statusCode, 409);
    assert.equal(await fs.readFile(filePath, 'utf8'), '# Updated');
  });
});

test('sendLocalImage only serves generated, uploaded, or desktop images', async () => {
  await withTempService(async (service, paths) => {
    const generatedResponse = res();
    await service.sendLocalImage(
      req(),
      generatedResponse,
      new URL(`http://local/api/local-image?path=${encodeURIComponent(path.join(paths.generatedRoot, 'image.png'))}`)
    );
    assert.equal(generatedResponse.statusCode, 200);
    assert.equal(generatedResponse.headers['content-type'], 'image/png');

    const uploadResponse = res();
    await service.sendLocalImage(
      req(),
      uploadResponse,
      new URL(`http://local/api/local-image?path=${encodeURIComponent(path.join(paths.uploadRoot, 'upload.png'))}`)
    );
    assert.equal(uploadResponse.statusCode, 200);

    const desktopImageResponse = res();
    await service.sendLocalImage(
      req(),
      desktopImageResponse,
      new URL(`http://local/api/local-image?path=${encodeURIComponent(path.join(paths.desktopImageRoot, 'desktop.png'))}`)
    );
    assert.equal(desktopImageResponse.statusCode, 200);

    const blockedResponse = res();
    await service.sendLocalImage(
      req(),
      blockedResponse,
      new URL(`http://local/api/local-image?path=${encodeURIComponent(path.join(paths.root, 'secret.txt'))}`)
    );
    assert.equal(blockedResponse.statusCode, 404);
  });
});

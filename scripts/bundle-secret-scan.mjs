import fs from 'node:fs/promises';
import path from 'node:path';

const SECRET_PATTERN = /sk-[a-z0-9_-]{16,}|api[_-]?key|secret[_-]?(key|token|value)/i;
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.txt', '.map']);

async function walkFiles(rootDir) {
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function findSecretLikeMatches(rootDir, { maxMatches = 20 } = {}) {
  const files = await walkFiles(rootDir);
  const matches = [];
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      continue;
    }
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (SECRET_PATTERN.test(line)) {
        matches.push({
          file,
          line: index + 1,
          text: line.slice(0, 240)
        });
        if (matches.length >= maxMatches) {
          return matches;
        }
      }
    }
  }
  return matches;
}

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGET_DIRS = ['app', 'components', 'lib'];
const IGNORE_DIRS = new Set(['node_modules', '.next', 'backup-20260216-182441']);

const issues = [];

const walk = (dirPath) => {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('backup-')) continue;
      walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;
    checkFile(fullPath);
  }
};

const checkFile = (filePath) => {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const content = readFileSync(filePath, 'utf8');

  if (/Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/.test(content)) {
    issues.push(`${rel}: wildcard CORS header detected`);
  }

  if (/transition\s*:\s*all\b/.test(content)) {
    issues.push(`${rel}: transition: all detected`);
  }

  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (/key=\{\s*(i|idx|index|rowIdx|commentIndex)\s*\}/.test(line)) {
      issues.push(`${rel}:${lineNo}: unstable index key detected`);
    }
    if (/key=\{[^}]*\$\{index\}/.test(line)) {
      issues.push(`${rel}:${lineNo}: template key includes index`);
    }
  });
};

for (const dir of TARGET_DIRS) {
  const full = path.join(ROOT, dir);
  if (!statSync(full, { throwIfNoEntry: false })) continue;
  walk(full);
}

if (issues.length > 0) {
  console.error('Lint guards failed:');
  issues.forEach((issue) => console.error(`- ${issue}`));
  process.exit(1);
}

console.log('Lint guards passed.');

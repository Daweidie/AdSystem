const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

const sourceDirectory = path.resolve(__dirname, '../src');
for (const file of javascriptFiles(sourceDirectory)) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('后端 JavaScript 语法构建检查通过');

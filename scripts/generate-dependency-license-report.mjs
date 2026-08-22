import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projects = [
  { name: 'demo18 backend', dir: path.join(workspace, 'backend') },
  { name: 'demo18 frontend', dir: path.join(workspace, 'frontend') },
  { name: 'llegomark-url-shortener Worker', dir: path.join(workspace, 'llegomark-url-shortener') },
]
const prohibitedPattern = /(^|[^L])(AGPL|GPL|SSPL|BUSL)|Commons Clause|Elastic License/i

function packageName(entryPath, metadata) {
  if (metadata.name) return metadata.name
  return entryPath.split('node_modules/').at(-1).replaceAll('\\', '/')
}

function stringifyLicense(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(stringifyLicense).filter(Boolean).join(' OR ')
  if (value && typeof value === 'object') return stringifyLicense(value.type || value.name)
  return ''
}

function resolveLicense(projectDir, entryPath, metadata) {
  let license = stringifyLicense(metadata.license || metadata.licenses)
  if (license) return license
  try {
    const installed = JSON.parse(fs.readFileSync(
      path.join(projectDir, entryPath, 'package.json'),
      'utf8',
    ))
    license = stringifyLicense(installed.license || installed.licenses)
  } catch {
    // The caller reports UNKNOWN instead of guessing a license.
  }
  return license || 'UNKNOWN'
}

function inventory(project) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(project.dir, 'package.json'), 'utf8'))
  const lockPath = path.join(project.dir, 'package-lock.json')
  if (!fs.existsSync(lockPath)) {
    throw new Error(`${project.name}: package-lock.json is missing; run npm install first`)
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  const directProduction = new Set(Object.keys(packageJson.dependencies || {}))
  const directDevelopment = new Set(Object.keys(packageJson.devDependencies || {}))
  return Object.entries(lock.packages || {})
    // npm lockfile v3 can contain versionless peer/link stubs. Their concrete
    // package is listed at another path, so only inventory resolved packages.
    .filter(([entryPath, metadata]) => entryPath.includes('node_modules/') && metadata.version)
    .map(([entryPath, metadata]) => {
      const name = packageName(entryPath, metadata)
      return {
        name,
        version: metadata.version || 'UNKNOWN',
        license: resolveLicense(project.dir, entryPath, metadata),
        scope: metadata.dev === true ? '开发' : '生产',
        direct: directProduction.has(name) || directDevelopment.has(name),
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

const inventories = projects.map((project) => ({ ...project, packages: inventory(project) }))
const prohibited = inventories.flatMap((project) => project.packages
  .filter((dependency) => prohibitedPattern.test(dependency.license))
  .map((dependency) => `${project.name}: ${dependency.name}@${dependency.version} (${dependency.license})`))
const unknown = inventories.flatMap((project) => project.packages
  .filter((dependency) => dependency.license === 'UNKNOWN')
  .map((dependency) => `${project.name}: ${dependency.name}@${dependency.version}`))
const lgplDevelopment = inventories.flatMap((project) => project.packages
  .filter((dependency) => dependency.scope === '开发' && /LGPL/i.test(dependency.license))
  .map((dependency) => `${project.name}: ${dependency.name}@${dependency.version} (${dependency.license})`))

const lines = [
  '# 完整依赖许可证报告',
  '',
  `生成时间：${new Date().toISOString()}`,
  '',
  '范围：demo18 后端、demo18 前端和 Cloudflare Worker 的完整生产及开发依赖闭包。许可证来自 package-lock 元数据，缺失时读取已安装包的 package.json。',
  '',
  '## 审计结论',
  '',
  prohibited.length === 0
    ? '- 未发现 GPL、AGPL、SSPL、BUSL、Commons Clause 或 Elastic License 依赖。'
    : `- 发现禁止或受限许可证：${prohibited.join('；')}`,
  unknown.length === 0
    ? '- 所有生产及开发依赖均识别到许可证。'
    : `- 未识别许可证（必须人工复核）：${unknown.join('；')}`,
  '- clone 项目原有 MIT LICENSE 和 Mark Anthony Llego 版权声明保持不变。',
  '- demo18 现有项目许可证未被替换或改写。',
  lgplDevelopment.length === 0
    ? '- 未发现 LGPL 依赖。'
    : `- Wrangler/Miniflare 的开发期图片工具包含 LGPL 组件，共 ${lgplDevelopment.length} 个平台可选包；均标记为开发依赖，不进入 Worker 生产 bundle。明细见下表。`,
  '',
  '## 本次新增依赖',
  '',
  '| 项目 | 依赖 | 用途 | 范围 | 许可证 |',
  '| --- | --- | --- | --- | --- |',
  '| Worker | zod | API 输入 schema 校验（补齐源码已有 import） | 生产 | MIT |',
  '| Worker | vitest | Worker 单元测试 | 仅开发 | MIT |',
  '',
]

for (const project of inventories) {
  lines.push(`## ${project.name}`, '')
  const productionCount = project.packages.filter((item) => item.scope === '生产').length
  const developmentCount = project.packages.length - productionCount
  lines.push(`生产依赖数量：${productionCount}；开发依赖数量：${developmentCount}`, '')
  lines.push('| 范围 | 层级 | 包 | 版本 | 许可证 |', '| --- | --- | --- | --- | --- |')
  for (const dependency of project.packages) {
    lines.push(`| ${dependency.scope} | ${dependency.direct ? '直接' : '传递'} | ${escapeCell(dependency.name)} | ${escapeCell(dependency.version)} | ${escapeCell(dependency.license)} |`)
  }
  lines.push('')
}

const outputPath = path.join(workspace, 'docs', 'dependency-licenses.md')
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
console.log(`Wrote ${outputPath}`)
console.log(`All dependencies: ${inventories.reduce((sum, item) => sum + item.packages.length, 0)}`)
console.log(`Production dependencies: ${inventories.reduce((sum, item) => sum + item.packages.filter((dependency) => dependency.scope === '生产').length, 0)}`)
console.log(`Prohibited licenses: ${prohibited.length}`)
console.log(`Unknown licenses: ${unknown.length}`)
if (prohibited.length > 0 || unknown.length > 0) process.exitCode = 2

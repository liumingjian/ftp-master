import type { components } from './api/schema.gen'

type Node = components['schemas']['TreeNode']

export const sampleFolderId = 12
export const sampleFileId = 21
const report = {
  period: '2026 年 11 月',
  title: '华东区域项目交付与风险跟踪',
  team: '项目交付组',
  summary: '本月 18 个交付节点中，15 个已完成，2 个按计划推进，1 个需要协调。苏州站点的接口联调是本周唯一需要跟进的事项。',
  metrics: [['15', '已完成'], ['2', '进行中'], ['1', '待协调']],
  focus: '苏州站点 · 接口联调',
  next: '测试环境已就绪，待业务方确认验收清单。交付组将在 11 月 25 日复核并更新进度。',
}

export const reportSource = [
  '# ' + report.title,
  report.period + ' · ' + report.team,
  '## 交付概况',
  report.summary,
  ...report.metrics.map(([count, label]) => '- ' + label + '：' + count),
  '## ' + report.focus,
  report.next,
].join('\n\n') + '\n'

const modified = '2026-11-23T02:42:00Z'
const directoryRights = 7
const fileRights = 27
function folder(id: number, name: string, parentId?: number): Node {
  return { id, name, parentId, isFile: false, rights: id === sampleFolderId ? directoryRights | 16 : directoryRights, traversable: false }
}
function file(id: number, name: string, size: number, username: string, createdAt = modified): Node {
  return { id, parentId: sampleFolderId, name, isFile: true, rights: id === sampleFileId ? fileRights | 32 : id === 22 ? 1 : fileRights, traversable: false,
    latestVersion: { id: id * 10 + 3, format: name.split('.').at(-1)!, size, username, createdAt } }
}

export const sampleNodes = [
  folder(10, '项目交付'),
  folder(13, '公共模板'),
  folder(14, '团队资料'),
  folder(11, '华东区域', 10),
  folder(15, '华南区域', 10),
  folder(12, '月度简报', 11),
  folder(16, '交付记录', 11),
  folder(17, '往期归档', 12),
  file(21, report.title + '月度简报（2026年11月）.md', new TextEncoder().encode(reportSource).length, '林若宁'),
  file(22, report.title + '月度简报（2026年10月）.md', 2194, '林若宁', '2026-10-27T06:15:00Z'),
  file(23, '华东区域交付节点台账（2026年11月）.xlsx', 43820, '陈嘉言', '2026-11-21T03:26:00Z'),
  file(24, '苏州站点验收问题清单.csv', 13602, '吴可欣', '2026-11-22T08:18:00Z'),
  file(25, '十一月交付协调会纪要.txt', 4224, '陈嘉言', '2026-11-19T02:03:00Z'),
  file(26, '供应商接口对接记录.docx', 86847, '吴可欣', '2026-11-17T05:12:00Z'),
  file(27, '交付材料与验收凭证.zip', 3691330, '林若宁', '2026-11-15T03:08:00Z'),
]

// PROTOTYPE mock data: an in-memory Shared Tree, Users and Grants. Wipe freely.

export type PrincipalKind = 'user' | 'org' | 'group'
export type Right = 'list' | 'read' | 'write' | 'modify' | 'delete' | 'grant'
/**
 * level is kept for the older variants (derived from rights when rights exist).
 * Round 6 adds FTP-style rights, a scope (Serv-U "inherit" / NTFS "applies to"), and the creator origin.
 */
export type Grant = { kind: PrincipalKind; id: string; label: string; level: number; rights?: Right[]; scope?: 'tree' | 'here'; origin?: 'creator' }
export type Version = { v: number; at: string; by: string; size: number; stale?: boolean }
export type AuditEvent = { at: string; who: string; what: string; ok: boolean; ip: string }

export type Node = {
  id: string
  name: string
  type: 'dir' | 'file'
  size: number
  modified: string
  modifiedBy: string
  grants: Grant[]
  children?: Node[]
  parent?: Node
  versions?: Version[]
  audit?: AuditEvent[]
  /** PROTOTYPE C2 only: Confluence-style restriction that stops inheritance here. Not in the current model (no deny). */
  isolated?: boolean
}

export type User = {
  id: string
  name: string
  orgLabel: string
  orgs: string[] // own Organization plus its ancestors
  groups: string[]
  admin: boolean
  inactive?: boolean
}

export const USERS: User[] = [
  { id: 'zhangsan', name: '张三', orgLabel: '研发部 / 后端组', orgs: ['company', 'rd', 'rd-be'], groups: ['park'], admin: false },
  { id: 'lisi', name: '李四', orgLabel: '财务部', orgs: ['company', 'fin'], groups: [], admin: false },
  { id: 'zhaoliu', name: '赵六', orgLabel: '市场部', orgs: ['company', 'mkt'], groups: ['dmp'], admin: false },
  { id: 'admin', name: '王管理', orgLabel: '信息中心', orgs: ['company', 'it'], groups: [], admin: true },
]

/** Everyone in the directory, including people you cannot switch to in the prototype bar. */
export const PEOPLE: User[] = [
  ...USERS,
  { id: 'sunqi', name: '孙七', orgLabel: '研发部 / 后端组', orgs: ['company', 'rd', 'rd-be'], groups: ['park'], admin: false },
  { id: 'zhouba', name: '周八', orgLabel: '研发部 / 前端组', orgs: ['company', 'rd', 'rd-fe'], groups: [], admin: false },
  { id: 'wujiu', name: '吴九', orgLabel: '财务部', orgs: ['company', 'fin'], groups: ['park'], admin: false },
  { id: 'qianshi', name: '钱十', orgLabel: '市场部', orgs: ['company', 'mkt'], groups: ['dmp'], admin: false, inactive: true },
]

export type Org = { id: string; name: string; parent?: string }
export const ORGS: Org[] = [
  { id: 'company', name: '全公司' },
  { id: 'rd', name: '研发部', parent: 'company' },
  { id: 'rd-be', name: '后端组', parent: 'rd' },
  { id: 'rd-fe', name: '前端组', parent: 'rd' },
  { id: 'fin', name: '财务部', parent: 'company' },
  { id: 'mkt', name: '市场部', parent: 'company' },
  { id: 'it', name: '信息中心', parent: 'company' },
  { id: 'rd-qa', name: '测试组', parent: 'rd' },
  { id: 'rd-ops', name: '运维组', parent: 'rd' },
  { id: 'sales', name: '销售部', parent: 'company' },
  { id: 'sales-n', name: '华北区', parent: 'sales' },
  { id: 'sales-s', name: '华南区', parent: 'sales' },
  { id: 'hr', name: '人力资源部', parent: 'company' },
]

export type Group = { id: string; name: string }
export const GROUPS: Group[] = [
  { id: 'park', name: '智慧园区项目组' },
  { id: 'dmp', name: '数据中台项目组' },
  { id: 'release', name: '发布评审组' },
  { id: 'budget', name: '预算编制小组' },
  { id: 'newbie', name: '2026 届新员工' },
]

// ~200 generated people so pickers, lists and matrices are tested at real company scale.
const SUR = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'
const GIV = ['伟', '芳', '娜', '敏', '静', '强', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超', '秀英', '霞', '平', '刚', '桂英', '文', '辉', '鹏', '华', '红', '玉兰', '飞', '建华', '丹', '晨', '宇', '浩然', '子涵', '欣怡', '梓轩', '思远', '雨桐', '一鸣', '嘉怡']
const SLOTS: [string, number][] = [['rd-be', 26], ['rd-fe', 22], ['rd-qa', 16], ['rd-ops', 10], ['rd', 4], ['fin', 12], ['mkt', 18], ['sales-n', 24], ['sales-s', 22], ['hr', 9], ['it', 8], ['company', 3]]
function chain(id: string): string[] {
  const out: string[] = []
  for (let o = ORGS.find((x) => x.id === id); o; o = ORGS.find((x) => x.id === o!.parent)) out.unshift(o.id)
  return out
}
const taken = new Set(['张三', '李四', '赵六', '王管理', '孙七', '周八', '吴九', '钱十'])
let k = 0
for (const [org, count] of SLOTS)
  for (let i = 0; i < count; i++, k++) {
    let name = ''
    for (let j = 0; !name || taken.has(name); j++) name = SUR[(k * 7 + j * 13) % SUR.length] + GIV[(k * 11 + j * 3) % GIV.length]
    taken.add(name)
    const orgs = chain(org)
    const groups = [k % 9 === 0 && 'park', k % 13 === 0 && 'dmp', org.startsWith('rd') && k % 4 === 0 && 'release', (org === 'fin' || k % 17 === 0) && 'budget', k % 11 === 3 && 'newbie'].filter(Boolean) as string[]
    PEOPLE.push({
      id: `p${k}`, name, orgs, groups, admin: false, inactive: k % 37 === 5,
      orgLabel: orgs.slice(1).map((o) => ORGS.find((x) => x.id === o)!.name).join(' / ') || '全公司',
    })
  }
/** Lots of one-off individual Grants, the thing Confluence warns about at scale. */
const SPRAWL = PEOPLE.filter((u) => u.orgs.includes('sales')).slice(0, 23)

const G = {
  company: (level: number): Grant => ({ kind: 'org', id: 'company', label: '全公司', level }),
  rd: (level: number): Grant => ({ kind: 'org', id: 'rd', label: '研发部', level }),
  fin: (level: number): Grant => ({ kind: 'org', id: 'fin', label: '财务部', level }),
  park: (level: number): Grant => ({ kind: 'group', id: 'park', label: '智慧园区项目组', level }),
  dmp: (level: number): Grant => ({ kind: 'group', id: 'dmp', label: '数据中台项目组', level }),
  lisi: (level: number): Grant => ({ kind: 'user', id: 'lisi', label: '李四', level }),
  sunqi: (level: number): Grant => ({ kind: 'user', id: 'sunqi', label: '孙七', level }),
  mkt: (level: number): Grant => ({ kind: 'org', id: 'mkt', label: '市场部', level }),
  qianshi: (level: number): Grant => ({ kind: 'user', id: 'qianshi', label: '钱十', level }),
  release: (level: number): Grant => ({ kind: 'group', id: 'release', label: '发布评审组', level }),
}

let seq = 0
const MB = 1024 * 1024

function d(name: string, grants: Grant[], children: Node[], modified = '2026-11-10 09:12', by = '王管理'): Node {
  return { id: `n${seq++}`, name, type: 'dir', size: 0, modified, modifiedBy: by, grants, children }
}

const creator = (id: string, label: string): Grant => ({ kind: 'user', id, label, level: 4, origin: 'creator' })

function f(name: string, size: number, modified: string, by: string, extra: Partial<Node> = {}): Node {
  const versions: Version[] = extra.versions ?? [{ v: 1, at: modified, by, size }]
  const audit: AuditEvent[] = extra.audit ?? [
    { at: modified, who: by, what: versions.length > 1 ? '保存（新版本）' : '上传', ok: true, ip: '10.2.3.14' },
    { at: '2026-11-14 16:40', who: '王管理', what: '下载', ok: true, ip: '10.2.1.8' },
  ]
  return { id: `n${seq++}`, name, type: 'file', size, modified, modifiedBy: by, grants: [], versions, audit, ...extra }
}

export const ROOT: Node = d('全部文件', [], [
  d('研发部', [G.rd(4)], [
    d('后端组', [], [
      d('设计文档', [G.sunqi(1)], [
        f('接口规范 v3.docx', 2.1 * MB, '2026-11-15 18:02', '张三', {
          grants: [creator('zhangsan', '张三')],
          versions: [
            { v: 3, at: '2026-11-15 18:02', by: '张三', size: 2.1 * MB },
            { v: 2, at: '2026-11-12 10:30', by: '孙七', size: 1.9 * MB },
            { v: 1, at: '2026-10-30 14:00', by: '张三', size: 1.2 * MB },
          ],
        }),
        f('数据库设计.xlsx', 0.86 * MB, '2026-11-08 11:20', '孙七'),
        f('架构图.png', 4.2 * MB, '2026-11-01 09:00', '张三', { grants: [creator('zhangsan', '张三'), { kind: 'group', id: 'release', label: '发布评审组', level: 2, rights: ['list', 'read'] }] }),
      ], '2026-11-15 18:02', '张三'),
      d('发布包', [G.release(2), ...SPRAWL.map((u): Grant => ({ kind: 'user', id: u.id, label: u.name, level: 1 }))], [f('ftp-master-1.4.2.tar.gz', 180 * MB, '2026-11-13 22:10', 'CI')], '2026-11-13 22:10', 'CI'),
    ], '2026-11-15 18:02', '张三'),
    d('前端组', [], [
      f('组件库说明.md', 0.04 * MB, '2026-11-09 15:00', '周八'),
      f('设计稿.zip', 64 * MB, '2026-11-03 10:00', '周八'),
    ]),
  ]),
  d('财务部', [G.fin(4)], [
    f('2026 年度预算.xlsx', 3.4 * MB, '2026-11-11 17:45', '李四'),
    f('报销制度.pdf', 1.1 * MB, '2026-06-01 09:00', '李四'),
    d('凭证', [], [f('2026-10 凭证汇总.xlsx', 5.6 * MB, '2026-11-05 10:00', '李四')]),
  ]),
  d('项目', [], [
    d('2026-智慧园区', [G.park(3)], [
      d('合同', [G.lisi(1)], [
        f('总包合同.pdf', 8.8 * MB, '2026-09-20 10:00', '张三'),
        f('补充协议一.docx', 0.4 * MB, '2026-11-16 09:40', '孙七', {
          grants: [creator('sunqi', '孙七')],
          versions: [
            { v: 4, at: '2026-11-16 09:40', by: '孙七', size: 0.4 * MB, stale: true },
            { v: 3, at: '2026-11-16 09:31', by: '张三', size: 0.41 * MB },
            { v: 2, at: '2026-11-14 15:00', by: '张三', size: 0.38 * MB },
            { v: 1, at: '2026-11-10 11:00', by: '孙七', size: 0.3 * MB },
          ],
          audit: [
            { at: '2026-11-16 09:40', who: '孙七', what: '保存（基于 v2，过期保存）', ok: true, ip: '10.2.3.40' },
            { at: '2026-11-16 09:31', who: '张三', what: '保存（新版本）', ok: true, ip: '10.2.3.14' },
            { at: '2026-11-16 08:55', who: '孙七', what: '打开编辑', ok: true, ip: '10.2.3.40' },
            { at: '2026-11-15 19:02', who: '李四', what: '下载', ok: false, ip: '10.2.5.7' },
          ],
        }),
        f('付款计划.xlsx', 0.2 * MB, '2026-11-02 14:00', '张三', { grants: [creator('zhangsan', '张三')] }),
      ], '2026-11-16 09:40', '孙七'),
      d('方案', [], [
        f('实施方案.docx', 31 * MB, '2026-10-28 18:00', '张三'),
        f('汇报演示.pptx', 12 * MB, '2026-11-06 09:00', '张三'),
      ]),
    ], '2026-11-16 09:40', '孙七'),
    d('2025-数据中台', [G.dmp(2), G.qianshi(3)], [
      f('验收报告.pdf', 2.4 * MB, '2025-12-20 10:00', '赵六'),
      f('数据字典.xlsx', 1.3 * MB, '2025-12-18 10:00', '赵六'),
    ]),
  ]),
  d('公共资料', [G.company(1)], [
    f('员工手册.pdf', 6.1 * MB, '2026-03-01 09:00', '王管理'),
    d('模板', [G.mkt(3)], [
      f('周报模板.docx', 0.05 * MB, '2026-01-05 09:00', '王管理'),
      f('市场活动方案.docx', 0.6 * MB, '2026-11-12 16:20', '赵六', { grants: [creator('zhaoliu', '赵六')] }),
    ]),
    d('资料投递', [{ kind: 'org', id: 'company', label: '全公司', level: 1, rights: ['write'], scope: 'here' }], [], '2026-11-01 09:00'),
  ]),
])

function linkParents(n: Node) {
  for (const c of n.children ?? []) {
    c.parent = n
    linkParents(c)
  }
}
linkParents(ROOT)

export const RECYCLE_BIN = [
  { name: '旧版接口规范.docx', from: '/研发部/后端组/设计文档', by: '张三', at: '2026-11-12 10:00', purgeIn: '23 天' },
  { name: '临时', from: '/项目/2026-智慧园区', by: '张三', at: '2026-11-01 18:00', purgeIn: '12 天' },
]

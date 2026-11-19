# PROTOTYPE — file browser UI variants (throwaway)

Question: what should the file browser over the Shared Tree look like?

Round 1 compared three layouts (A explorer, B columns, C entry/search first); A's layout won.
Round 2 varied A's interaction model (A1 hover-to-act, A2 keyboard, A3 proactive, A4 preview); A1 won.
Round 3 keeps A1 and asks how it should move and feel. Folders the User can only pass through
(Traversable Ancestors) are no longer shown; permitted items beneath them are hoisted up with a path hint.

- `F`  **round 3 pick**: M2's calm motion, plus M1's delete-flies-into-the-bin
- `A1` round 2 winner, as a baseline
- `M1` spring: physical springs, directional navigation, staggered rows, deletes fly into the bin
- `M2` calm: fast fades, cursor spotlight, skeletons and a top progress bar, nothing bounces
- `M3` glass: frosted panels over an ambient gradient, depth transitions, tilting cards, floating inspector

Shared in M1–M3: hover peek, lasso / shift-click / ⌘A selection, spring-loaded folders while dragging,
drag onto the bin to delete, stacked drag ghost, upload button that becomes a progress ring, animated
sorting, dark mode with a circular reveal, prefers-reduced-motion respected.

Verdict of round 3: M2 as the base, borrowing only M1's fly-to-bin delete. That is variant `F`.

Earlier variants are in this branch's git history.

Round 4 keeps F and asks: what should making and explaining Grants look like? (spec #1, stories 30–38)

- `P1` **共享弹窗**: item-centric modal. Add a person/Organization/User Group with a level; direct Grants editable,
  inherited ones grouped by source with a link to go change them there; "N more specific Grants inside"; check anyone's permission.
- `P2` **侧栏刻度条**: inside the inspector. One 4-step bar per principal; inherited levels are a grey locked floor,
  direct Grants fill above it; click a step to set, click again to revoke. "Why can I…" card on top.
- `P3` **权限矩阵**: a page (sidebar "权限总览"). Folders × principals over a subtree; solid = direct, faint = inherited,
  a small struck tag = a direct Grant that does nothing. Hover explains, click edits.
- `P4` **以人为中心**: a page (sidebar "按人查看权限"). Pick a person/Organization/User Group, see every folder they
  reach, from where and why, and grant from there. Only shows what the acting User can see.

Shared rules the UIs must make visible: no deny, so a direct Grant at or below the inherited level has no effect;
inherited Grants change only at their source; Manage holders grant only within their scope; changing a Grant that would
remove your own Manage asks first; deactivated Users keep inert Grants. Logic in `src/grants.ts`; changes apply at once
with an undo toast. Good identities to try: 张三 (Manage on 研发部 only), 王管理 (Administrator), 赵六 (no Manage).

Switch via `?variant=`, the floating bottom bar, or ← →. The bar also switches the signed-in User (`?user=`)
and whether the Office Plugin is present (`?plugin=1`).

Data is in memory (`src/data.ts`, mutated by `src/store.ts`); reload to reset. Open/edit/download are stubs.

    pnpm install && pnpm dev

Round 5 asks the same question at real scale (~200 people, 13 Organizations, 5 User Groups, one folder with 23 stray
individual Grants under 研发部/后端组/发布包), borrowing from Confluence's permission management:

- `C1` **空间权限表** (Confluence Space permissions): top-level folders are spaces; principals × levels checkbox table,
  tabs 组织与用户组 / 个人 / 子文件夹例外, filter, paging, bulk set, and edit-then-"保存全部" (batched, not instant).
- `C2` **访问限制弹窗** (Confluence Restrictions): 沿用上级 / 在上级基础上追加 / 仅限指定的人, with an impact preview
  ("保存后 N 人失去访问"). The third mode stops inheritance, which contradicts "Grants only ever allow" and is out of
  spec scope; it is here to decide whether that is worth changing. Implemented via `Node.isolated` + `scopePath()`.
- `C3` **权限检查** (Confluence Inspect permissions): person + location → verdict, capability checklist, identity chain ×
  folder chain; reverse tab "谁能访问这里" with counts per level and people grouped by the Grant that gives them access.
- `C4` **用户组优先** (Confluence's "grant to groups"): inspector shows group cards with reach, folds individual Grants away,
  warns when they pile up, merges them into a new User Group in one click, and nudges toward a group when picking a person.

The principal picker now caps results per kind and asks you to keep typing, since 200 rows is not browsable.

Round 6 (`D1`, default) takes C1's table to every level and swaps the four levels for FTP-convention rights:

- Left tree of the space (folders, plus files carrying Grants; badges = Grants made there, orange = many individual),
  right a C1-style table for the selected folder or file, drafted and saved together with an impact preview.
- Columns 浏览 / 下载 / 上传 / 修改 / 删除 / 授权 (Serv-U, FileZilla Server and NTFS split rights this way), with a
  preset per row: 仅浏览, 只读, 读写, 读写删, 完全控制, 投递箱. Dependencies are kept coherent (授权 ⇒ all; no 浏览 ⇒ no
  下载/修改/删除). You can only hand out rights you hold.
- Scope per folder Grant: 本层及以下 / 仅本层 (Serv-U "inherit", NTFS "applies to"); granting a big Organization
  tree-wide over a large subtree warns and suggests 仅本层. Still no deny: inherited rights are grey and locked.
- A file's creator gets a pinned, locked "创建者" row with every right (an automatic Grant, `origin: 'creator'`).
  Without 授权 on the folder, a creator can share only with people who can already see the folder.
- Try: 王管理 on 研发部/后端组/发布包; 张三 on 项目/2026-智慧园区/合同/付款计划.xlsx (⋯ → 授权), search 赵六;
  公共资料/资料投递 is a 投递箱 for 全公司 at 仅本层.

Verdict (2026-11-17): **D1 is the Grant design.** Rights replace Permission Levels (浏览 下载 上传 修改 删除 授权,
with presets including 投递箱), every Grant on a folder has a scope (本层及以下 / 仅本层), still no deny, a file's
uploader gets an automatic Creator Grant with every right and can share only within the folder's audience, and one
left-tree / right-table page serves every level with drafted changes and an impact preview. Recorded in GLOSSARY.md,
ADR 0006 and issue #1. Open: 等保 level (三员分立), whether Creator Grants also apply to folders (prototype: files only).

Round 7 (`T1`–`T4`, default `T3` since the verdict) keeps D1 and asks: **where should transfers live, and how do they explain the hard cases?**
(spec #1, stories 39–49 and 92). All four run on the same fake engine, `src/transfers.ts`: 64 MB parts, 3 files at a time
sharing a 112 MB/s link, a network drop loses only the part in flight, a page reload keeps the server-side multipart session
but loses the browser's File (the User must pick the same file again), single downloads are handed to the browser's own
download manager (no in-app progress), zips are refused above 10 GB before they start, blocked extensions and files over
20 GB are refused up front, and a Drop Box silently renames on a clash with a file the uploader cannot see.

- `T1` **角落托盘**: Drive-style collapsible card bottom right. Folder drops are one row (expand for files); same-name
  conflicts ask inside the card (全部存为新版本 / 全部保留两者 / 逐个选择) while the rest keeps going.
- `T2` **传输页**: a sidebar destination like a sync client. Tabs 上传中 / 下载 / 已完成 / 未上传·已取消, a full table with
  location, parts, speed, ETA, pause-all; conflicts are decided up front in a desktop-copy-style dialog.
- `T3` **就地进度**: no panel. Uploads are rows in the destination folder filling up like files arriving; conflicts and
  "re-pick after reload" are asked on the row; a header pill lists uploads landing elsewhere; downloads only toast.
- `T4` **先确认后传**: every drop opens a preflight sheet (count, size, ETA, folder structure, refused files with reasons,
  per-file 新版本 / 保留两者) and nothing starts until 开始上传; afterwards a header activity bubble covers both directions.

The dashed yellow 🧪 panel (bottom left) is the simulator, not design: scenarios (3 files, same names, a 41-file folder,
18 GB, .exe + 25 GB, 12 GB zip), 断网 8 秒, 刷新页面, 快进 ×10, and the engine state. Try 王管理 in 研发部/后端组/发布包
(it has a file to clash with), and 赵六 in 公共资料/资料投递 for a Drop Box.

Verdict (2026-11-17): **T3 is the transfer design, and downloads are the browser's own.** Uploads appear as rows in the
destination folder, filling up as they arrive (a folder drop is one row; its real folder stays hidden until done); same-name
conflicts, refused files and "pick the file again after a reload" are asked on that row while the rest keeps going; a header
pill lists uploads landing in other folders and the offline / reload banners sit above the table. There is no transfer
panel or page. Single-file and zip downloads go straight to the browser's download manager with no in-app progress or
toast; the only in-app message is the up-front refusal of a zip over 10 GB. Recorded in issue #1.
Also decided: in a Drop Box, a clash with a file the uploader cannot see is renamed silently, so the other file's name
never leaks; closing or reloading the page while uploads are still running asks first (the browser's own beforeunload prompt).

Round 8 (`L1`–`L4`, default `L1`) asks: **where and how should Audit Events be read?** (spec #1, stories 68–75). All four sit on T3.
The log (`src/audit.ts`) holds ~16k seeded events over 190 days plus live ones: uploads, deletes, renames, moves, downloads,
zips (one event per file), previews/edits (the stub alerts), Grant saves, exports and identity switches (= sign-out + sign-in)
are all recorded. Events are read-only everywhere; directory browsing is never recorded.

- `L1` **检索表**: sidebar 审计日志. Filter by person, location (folder or file), time, category, failures, free text;
  a per-day histogram (red = failures, click a day); dense table with the path at the time plus where it is now;
  detail drawer with pivots (只看此人 / 此文件 / 此 IP); CSV export (UTF-8 BOM, itself audited).
- `L2` **从问题出发**: sidebar 审计调查. Pick a question (这个文件谁动过 / 这个人做了什么 / 这里最近少了什么 / 谁下载最多 /
  异常登录 / 权限与账户变更), get a one-sentence answer, a table, a timeline, and 导出依据.
- `L3` **就地动态**: no console for department heads. The inspector of any file or folder you hold 授权 on gets a 动态 section
  (a folder includes everything beneath it); folders get a 动态 button next to 授权. Administrators also get one page,
  账户与登录审计, for what belongs to no file.
- `L4` **动态流**: sidebar 动态. Runs of the same action by the same person within 30 min (or the same zip) collapse into one
  card; previews and office-network sign-ins are hidden by default ("隐藏日常噪音"); signal cards on top
  (password-guessing burst, sign-in from an unknown address, off-hours bulk download, delete spree, stale saves, refused access).

Scripted incidents to look for: 李四 7 failed sign-ins from 172.16.9.23 at 02:10 on 11-15, then a success and two finance
downloads; 孙七 zipping 研发部 twice and 项目 once after 22:30 on 11-16; 周八 deleting 12 files on 11-13 (purged 11-16);
接口规范 v2 → v3 rename (11-12) and 设计稿.zip moved out of 公共资料 (11-03), whose older events keep the old path;
overlapping edits on 补充协议一 with a stale save; 李四's refused download.

Try identities: 王管理 (sees everything), 张三 (授权 on 研发部 only: sees only events there, no sign-ins/accounts/Grants;
the 孙七 signal shrinks to 12 files), 李四 (财务部), 赵六 (no 授权 on any folder: no audit entry at all).

Open questions this round raises:
- Scope by location: an item is "within" your folder if it is there now **or** was at the time (prototype choice), so
  张三 sees 设计稿.zip's history from when it sat in 公共资料. Alternative: only the location at the time.
- Does a file's Creator (授权 on the file only) see that file's audit? Prototype: no, only 授权 on a directory counts.
- Should delegated managers see Grant changes made inside their own folders? Story 73 says Administrators only.
- Should exporting audit be an Audit Event (auditing the auditors)? Prototype: yes, Administrator-only.
- Are previews worth recording at all, or only downloads? (Story 68 lists preview.)

Verdict of round 8 (2026-11-17): **L1's search table** is the base. Two changes from the user: audit is **Administrator-only**
(no delegated view for Grant-Right holders, so story 72 goes), and it needs a real **time range filter**. Its purpose:
when something goes wrong, find fast who did what, when.

Round 9 (`K1`–`K4`, default `K1`): four directions on L1, all Administrator-only (other identities get no audit entry),
all sharing one time range control (`RangeBar` in `src/VariantTrace.tsx`): presets (最近 1 小时 … 近 180 天), exact
from/to to the minute, a histogram whose bucket adapts to the span (5 min … 1 day; red = failures), drag across it to
zoom into that stretch, zoom out ×2, and undo back through earlier ranges. Exports are named after the range.

- `K1` **L1 + 精确时间范围**: L1's filters and table under the RangeBar. Detail drawer adds "前后 15 分钟所有人在做什么".
- `K2` **时间泳道**: one lane per person over the range (busiest first, but failures, deletes and off-hours activity float
  to the top), dots coloured by category, red for failures, grey bands for off-hours. Drag across the lanes to zoom;
  click a name to filter the table; "以此为中心 ±15 分钟" from any event.
- `K3` **追溯链 + 证据**: start from a symptom — a file or folder (search every path ever recorded, deleted and purged
  included), a person, an IP, or a moment (±30 min). Each click on an event offers a pivot (这次登录做的所有事, 此人前后
  2 小时, 这个文件的全部历史, 这个 IP, 同一时间所有人), which becomes a breadcrumb step. Pin events as evidence; pinned ones
  sorted by time read as the story of what happened, and export together.
- `K4` **查询语句**: one line, `人:孙七 操作:下载,删除 路径:/研发部 IP:… 结果:失败` plus free keywords, with key
  suggestions and plain-language example questions. Results grouped by sign-in session (who, IP, signed in at, signed
  out / expired after 2 h idle), sessions with failures, off-hours or outside addresses highlighted.

Sessions (`sessionOf` in `src/audit.ts`): same person and IP, from a sign-in until a sign-out, a new sign-in or 2 hours idle.

Verdict of round 9 (2026-11-19): **none of K1–K4.** The user wants audit kept simple: a plain event log an Administrator
can filter, not an investigation tool. No histogram, lanes, trace chains, query language or sign-in sessions. Decided:
- previews are **not** recorded; a zip download is **one** event listing its files; exporting is **not** recorded;
- the directory filter matches the **path at the time** (prefix; "include subdirectories" on by default), so after a
  directory is renamed or moved its older events are found under the old path; a zip matches if any file it packed was there;
- no 三员分立 audit-administrator role for now.

Round 10 (`S1`–`S3`, default `S1`) asks only: **what should that simple page look like?** All three are Administrator-only
(switch to 王管理), share the logic in `src/audit.ts` (`querySimple`, `zipEvent`, `knownDirs`) and offer the same filters:
time (今天 / 近 7 天 / 近 30 天 / 自定义 to the minute, at most 180 days), people (several, or an Organization and everyone
beneath it), directory (type any path, old ones included; suggestions mark paths that no longer exist) + 包含子目录,
action categories, 只看失败, CSV export. Every detail offers 只看此人 / 只看此目录 / 此文件全部历史 (by stable item id,
across renames and moves).

- `S1` **顶部筛选栏**: all filters in one bar above a dense paged table; details in a right-hand drawer.
- `S2` **左侧筛选面板**: a faceted panel (time radios, people with counts, a directory tree plus a path box, actions with
  counts); active filters as removable chips over the table; rows expand in place; "load more".
- `S3` **一句话条件**: one sentence, 查看 [近 7 天] 内 [所有人] 在 [所有目录] 的 [所有操作], each part a popover;
  results grouped by day with per-day counts and failures; details in a modal.

Things to try: directory `/研发部/后端组/设计文档` (renamed from `设计资料` on 11-05: only the newer events show; pick the
old path, marked 现已不在此路径, for the rest); directory `/研发部/后端组` catches 孙七's `研发部.zip` on 11-16 through
the files inside it (tag 包内文件在此目录); 此文件全部历史 on 接口规范 v3.docx joins its v2 name and both directory names;
Organization 研发部 (含下级); 只看失败 for 李四's password burst on 11-15.

Verdict of round 10 (2026-11-19): **S1 is the audit design.** One Administrator-only page, 审计日志: a single filter bar
(time presets 今天 / 近 7 天 / 近 30 天 / 自定义 to the minute, at most 180 days; people, several or an Organization with
everyone beneath it; directory by path at the time with 包含子目录; action categories; 只看失败; 重置), a dense paged
table (时间, 用户, 来源 IP, 操作, 对象（当时路径）), and a right-hand detail drawer listing every field, a zip's files,
and the pivots 只看此人 / 只看此目录 / 此文件全部历史. CSV export of the current result, not itself audited.

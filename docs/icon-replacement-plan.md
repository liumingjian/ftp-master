# Frontend Icon Replacement Plan (`gflow` CLI)

## 1. Objective & Design Positioning

Upgrade the high-visibility semantic icons in `ftp-master-web` (**图腾数安文件管理平台**) using assets generated via `gflow` CLI, elevating the desktop UI to commercial-grade software polish while maintaining the rigorous, restrained visual discipline expected in banking and archival environments.

**Core principles:**
- **Commercial craft without consumer clutter:** Replace generic thin-stroke wireframes only where rich semantic iconography increases scan speed and perceived product quality; preserve crisp monochrome vector controls for micro-interactions.
- **Banking-grade restraint:** Strictly front-facing orthographic silhouettes, matte archival materiality, low-saturation institutional color hierarchy, and calm object metaphors—no playful cartoons, floating particles, glassmorphism, or neon glows.
- **Single-source dual-theme support:** Every generated asset ships as a single transparent WebP (PNG for favicon) calibrated to read cleanly on both Light (`#ffffff` / `#fbfcfc` / `#f6f7f8`) and Dark (`#1d2122` / `#191c1e` / `#151819`) surfaces.
- **Zero-regression integration:** Preserve existing `FileIcon` exports, `data-format` hooks, accessibility semantics (`aria-hidden="true"` on decorative icons), and Playwright E2E selectors.

---

## 2. Scope & Tier Boundaries

The current frontend uses ~45 `lucide-react` icons across 27 components. Replacement is strictly bounded by visual tier:

| Tier | Surface | Count | Strategy | Target Display Sizes |
| :--- | :--- | :---: | :--- | :--- |
| **Tier 1 (Family A)** | File & directory types (`FileIcon`, `RecycleBin` items) | **14** | Replace with `gflow` icons | `16px` (sidebar tree / picker), `32px` (file table / viewer / grants), `36px` (inspector header) |
| **Tier 2 (Family B)** | Empty-state focal emblems (`TreePanel`, `RecycleBin`, `RegistrationsPanel`) | **5** | Replace with `gflow` icons | `56–64px` (standalone, no gray box) |
| **Tier 3 (Family C)** | Service status & system policy cards (`HealthPanel`, `UploadSettings`) | **7** | Replace with `gflow` icons | `36px` (service & policy cards), `44px` (health overview) |
| **Tier 4 (Family D)** | Browser tab app icon (`web/index.html` favicon) | **1** | Add dedicated square icon | `16px` / `32px` browser tab & bookmarks |
| **Explicitly Excluded** | Micro UI controls (~35 Lucide icons: `X`, chevrons, sort arrows, search, refresh, copy, check, eye, lock, action menus), sidebar navigation items (`16–18px`), principal entity chips (`Building2` / `Users` / `UserRound`), text-only empty states (`AuditPanel`, `MembershipPanel`, `VersionsPanel`, `AccountStorageSection`), header wordmark (`platform-logo.png`) | **0** | Keep existing `lucide-react` / brand wordmark | `12–18px` (`currentColor` inheritance) |

**Total planned assets:** **27 icons** (3 style anchors + 24 anchor-guided batch icons).

---

## 3. Banking-Grade Visual Specification

### 3.1 Geometry, Perspective & Materiality
- **Perspective:** Strict front-facing 2D orthographic view. No isometric tilt, no rotation, no 3D camera foreshortening.
- **Material finish:** Matte archival paper, brushed muted metal fasteners, clean flat color fills with at most one subtle soft layer shadow (2–4% elevation depth) to create tactile separation.
- **Symbol-only rule (zero embedded text):** Do not render letters or file extensions (`PDF`, `DOC`, `XLS`, `PPT`) inside icons. Pure geometric symbols guarantee readability at `16px`, avoid AI typography artifacts, and keep cross-format visual order disciplined.
- **Forbidden elements:** Cartoon characters, facial expressions, sparkles/stars, floating confetti/dots, glassmorphism blur, glossy plastic highlights, neon saturation, heavy drop shadows extending outside the icon silhouette.

### 3.2 Institutional Color Palette
Anchored directly to the existing tokens in `web/src/app.css` and the archival mood of `web/src/assets/archive.webp`:

| Semantic Role | Primary Hex | Secondary / Shade | Usage |
| :--- | :--- | :--- | :--- |
| **Archival Deep Teal** | `#12665b` | `#1b8071` / `#0e4f47` | Platform brand accent, Favicon, Upload empty state, Upload security policy |
| **Archival Brass / Manila** | `#8c6223` | `#b88b47` / `#6d4b19` | Standard folder, Drop-box folder, Archive package |
| **Institutional Navy** | `#285c96` | `#4679b2` / `#1e4673` | Word / WPS documents, Database card, Office edit accent |
| **Pine Emerald** | `#216b48` | `#398c65` / `#185036` | Excel / CSV spreadsheets, Healthy status badge |
| **Muted Burgundy** | `#9e323c` | `#bd4f59` / `#78222a` | PDF documents, Degraded status badge, Deleted file stamp |
| **Muted Ochre / Bronze** | `#9a5b25` | `#bc7b42` / `#75441a` | Slide decks (`ppt`/`pptx`), Cache service card |
| **Cold Slate** | `#4a585e` | `#6c7c83` / `#333e42` | Traversable folder, Generic/Text files, Object storage housing, Empty-state base structures |
| **Archival Paper Body** | `#e8ecee` | `#cfd7da` hairline border | Document page surfaces (avoids vanishing on `#ffffff` light panels and avoids harsh glare on `#1d2122` dark panels) |

### 3.3 Dual-Theme Contrast & Optical Grid Rules
- **No pure-white or near-black outer edges:** Every paper or light-colored element must carry a subtle cool-gray body (`#e4e9eb`–`#eef1f2`) and a crisp `1.5–2px` (at 128px scale) slate edge (`#7a8990` or family accent shade) so silhouettes stay defined on `#ffffff` panels without glowing harshly on `#1d2122` dark panels.
- **Canvas fill ratio (post-processed square):**
  - Family A (File & Directory): **82–86%** visual bounding box, centered on optical weight; bold inner motifs so silhouettes hold at `16px`.
  - Family B (Empty-State Emblems): **76–82%** visual bounding box, calm open breathing room.
  - Family C (Status & Policy Cards): **82–86%** visual bounding box.
  - Family D (Favicon): **88–92%** rounded-square badge (`border-radius ~22%`) for maximum `16px` browser-tab legibility.

---

## 4. Complete 27-Icon Inventory & Component Mapping

### 4.1 Family A — File & Directory Types (14 Icons)

Replaces the 5 monochrome Lucide shapes in `web/src/FileIcon.tsx` plus `FileX` in `web/src/RecycleBin.tsx`.

**Container behavior:**
- **`32px` / `36px` tile slots** (`TreePanel`, `FileViewer`, `GrantsPanel` header, `ItemInspectorDialog` header): Remove the legacy `.icon-tile` tinted square box background and render the icon directly at `28–32px` (and `36px` in `ItemInspectorDialog`) for a clean commercial file-manager silhouette.
- **`16px` compact tree slots** (`DirectorySidebar`, `DirectoryPicker`, `GrantsPanel` left tree): Reuse the same Family A icons at `16px` for uninterrupted visual continuity between tree navigation and the file table.

| # | `iconId` | UI Meaning | Format / Condition Match | Pure Geometric Motif (Zero Text) | Palette |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | `file-folder` ★ | 普通文件夹 | `!node.isFile` (default) | Upright archival manila folder with structured top-left tab and subtle front-pocket fold | Brass / Manila `#8c6223` + `#b88b47` |
| 2 | `file-folder-dropbox` | 投递箱目录 | `!node.isFile && !(rights & 1) && (rights & 4)` | Archival folder with a recessed top intake slot and clean downward-arrow tray mark in teal | Manila `#8c6223` + Teal `#12665b` accent |
| 3 | `file-folder-traversable` | 仅通行目录 | `!node.isFile && traversable && !rights` | Muted cold-slate folder with a restrained minimal corridor/pass-through chevron notch (signals transit-only visibility) | Cold Slate `#4a585e` + `#8d9ca2` |
| 4 | `file-word` | Word / WPS 文档 | `doc`, `docx`, `wps` | Upright folded-corner document sheet with navy header bar and clean aligned horizontal paragraph rules | Institutional Navy `#285c96` + Paper `#e8ecee` |
| 5 | `file-sheet` | Excel / CSV 表格 | `xls`, `xlsx`, `csv` | Upright folded-corner document sheet with pine-green header bar and crisp 3×3 tabular cell grid | Pine Emerald `#216b48` + Paper `#e8ecee` |
| 6 | `file-slides` | PPT 演示文稿 | `ppt`, `pptx`, `dps` | Upright folded-corner document sheet with ochre header bar and structured slide-deck frame + bar-chart block | Muted Ochre `#9a5b25` + Paper `#e8ecee` |
| 7 | `file-pdf` | PDF 定版文档 | `pdf` | Upright folded-corner document sheet with burgundy top seal band and minimal geometric archival stamp ribbon | Muted Burgundy `#9e323c` + Paper `#e8ecee` |
| 8 | `file-text` | 可编辑文本文档 | `txt`, `md`, `json`, `xml`, `yaml`, `yml`, `log`, `toml`, `ini`, `conf` | Upright folded-corner document sheet with slate-teal left rule and structured monospace code/text indent bars | Slate Teal `#2d5e63` + Paper `#e8ecee` |
| 9 | `file-image` | 图片文件 | `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `avif`, `bmp` | Upright folded-corner sheet housing a neat framed landscape silhouette (geometric horizon peaks + sun disc) | Slate Indigo `#3c5a78` + Teal `#12665b` |
| 10 | `file-video` | 视频文件 | `mp4`, `webm`, `mov` | Upright folded-corner sheet housing a crisp dark-slate media frame with centered geometric play triangle | Slate Plum `#56486b` + Paper `#e8ecee` |
| 11 | `file-audio` | 音频文件 | `mp3`, `wav`, `ogg`, `m4a` | Upright folded-corner sheet with centered symmetrical vertical acoustic waveform bars | Deep Teal `#12665b` + Slate `#4a585e` |
| 12 | `file-archive` | 压缩归档包 | `zip`, `rar`, `7z`, `tar`, `gz` | Compact bound archival box/folio with centered vertical metallic clasp/zipper track | Warm Bronze `#7a5621` + Slate `#4a585e` |
| 13 | `file-generic` | 通用文件（兜底） | Any unrecognized extension | Clean upright folded-corner neutral archival sheet with minimal faint geometric center mark | Cold Slate `#5e6b70` + Paper `#e8ecee` |
| 14 | `file-deleted` | 回收站已删除项 | `RecycleBin.tsx` item row (`22–28px`) | Muted slate folded document sheet with subtle diagonal corner notch and restrained burgundy cancel/removal seal | Slate `#6c7c83` + Burgundy `#9e323c` |

> ★ = Family A style anchor (`file-folder`).
> **Compatibility note:** Preserve `data-format` on `.file-icon` (`folder`, `folder-dropbox`, `folder-traversable`, `word`, `sheet`, `slides`, `pdf`, `text`, `image`, `video`, `audio`, `archive`, `generic`) and update `fileTypeLabel()` in `web/src/FileIcon.tsx` to include human-readable labels for `ppt/pptx/dps`, `csv`, `json/xml/yaml`, `png/jpg/webp`, `mp4/mov`, `mp3/wav`, and `zip/rar/7z`.

---

### 4.2 Family B — Empty-State Focal Emblems (5 Icons)

Replaces the 5 existing icon-bearing empty states, upgrading them from `24–26px` icons inside a `48px` gray box to calm, standalone `60px` (`56–64px`) emblems.

| # | `iconId` | Target Component & State | Display Size | Banking-Grade Object Motif | Palette |
| :-: | :--- | :--- | :---: | :--- | :--- |
| 15 | `empty-upload` ★ | `TreePanel.tsx` — writable empty folder (`点击选择文件，或拖到这里上传`) | `60px` | Open archival filing tray with a crisp document sheet hovering neatly in alignment and a subtle upward transfer arrow | Deep Teal `#12665b` + Manila `#b88b47` + Paper `#e8ecee` |
| 16 | `empty-folder` | `TreePanel.tsx` — read-only / non-uploadable empty folder (`此目录暂无文件`) | `60px` | Calm open empty archival folder with clean tabbed divider and visible empty interior pocket | Manila `#8c6223` + Cold Slate `#6c7c83` |
| 17 | `empty-search` | `TreePanel.tsx` — search returns zero rows (`没有匹配文件`) | `60px` | Neat blank archive card behind a precision matte-slate optical loupe/magnifying glass | Cold Slate `#4a585e` + Deep Teal `#12665b` rim |
| 18 | `empty-recycle` | `RecycleBin.tsx` — empty recycle bin (`回收站为空`) | `60px` | Clean architectural matte-metal archival waste bin with tidy closed/lifted rim and calm subtle check balance | Cold Slate `#5e6b70` + Teal `#12665b` detail |
| 19 | `empty-approvals` | `RegistrationsPanel.tsx` — no pending requests (`暂无待审批的申请`) | `60px` | Orderly empty approval inbox tray with a resting archival verification seal / check emblem | Deep Teal `#12665b` + Cold Slate `#5e6b70` |

> ★ = Family B style anchor (`empty-upload`).
> **Error-state note:** When `TreePanel.tsx` fails to load directory contents or search (`failed === true`), do not reuse `empty-folder` or `empty-search`; retain a clean Lucide `TriangleAlert` in danger tone so network/server errors stay visually distinct from normal empty states.

---

### 4.3 Family C — Service Status & System Policy Cards (7 Icons)

Replaces large `36–44px` feature icons in `HealthPanel.tsx` and `UploadSettings.tsx`.

| # | `iconId` | Target Component & Slot | Display Size | Banking-Grade Object Motif | Palette |
| :-: | :--- | :--- | :---: | :--- | :--- |
| 20 | `health-ok` | `HealthPanel.tsx` — overall system healthy (`运行状态 · 正常`) | `44px` | Precision octagonal/shield security seal with crisp centered verification check mark | Pine Emerald `#216b48` + Deep Teal `#12665b` |
| 21 | `health-degraded` | `HealthPanel.tsx` — overall system degraded (`运行状态 · 降级`) | `44px` | Structured architectural warning shield/diamond with bold restrained exclamation mark | Muted Burgundy `#9e323c` + Warm Ochre `#b45309` |
| 22 | `service-database` ★ | `HealthPanel.tsx` — `数据库` card (`元数据、组织架构与权限存储`) | `36px` | Three stacked precision matte-slate/navy cylindrical data tiers with subtle indicator notches | Institutional Navy `#285c96` + Cold Slate `#4a585e` |
| 23 | `service-storage` | `HealthPanel.tsx` — `对象存储` card (`文件实体与历史版本存储`) | `36px` | Modular steel vault / archival storage rack housing two neat sealed drawer cartridges | Deep Teal `#12665b` + Cold Slate `#4a585e` |
| 24 | `service-cache` | `HealthPanel.tsx` — `缓存` card (`会话状态与高频访问缓存`) | `36px` | Crisp layered high-speed memory block with restrained geometric pulse/bolt channel | Muted Ochre `#9a5b25` + Cold Slate `#4a585e` |
| 25 | `policy-office-edit` | `UploadSettings.tsx` — `Office 在线编辑` card | `36px` | Crisp structured document folio paired with an architectural drafting fountain/stylus nib | Institutional Navy `#285c96` + Deep Teal `#12665b` |
| 26 | `policy-upload-guard` | `UploadSettings.tsx` — `上传扩展名限制` card | `36px` | Archival security shield overlaid with a clean file-inspection filter gate | Deep Teal `#12665b` + Slate `#4a585e` |

> ★ = Family C style anchor (`service-database`).
> **Down-state handling (`HealthPanel.tsx`):** When an individual service card has `.down`, do **not** generate 3 extra red-broken icon variants. Keep the card's danger border, danger-tinted icon container ring, red status pill (`不可用`), and impact alert banner to communicate outage clearly while `health-degraded` leads the top banner.

---

### 4.4 Family D — Browser App Favicon (1 Icon)

| # | `iconId` | Target Location | Export Sizes | Motif & Rationale | Palette |
| :-: | :--- | :--- | :---: | :--- | :--- |
| 27 | `app-favicon` | `web/index.html` (`<link rel="icon">`) | `128×128` + `32×32` PNG | Rounded-square deep-teal banking vault shield enclosing an ultra-clean archival folder/keyhole monolith. Replaces the squashed `794×236` horizontal wordmark `platform-logo.png` in browser tabs while leaving `PlatformBrand.tsx` header branding unchanged. | Deep Teal `#12665b` + Warm Brass `#c8a25a` / Off-White `#eef1f2` |

---

## 5. `gflow` CLI Generation & Post-Processing Pipeline

### 5.1 Shared Prompt Architecture

All prompts share a fixed style discipline to lock consistency across all 27 icons:

- **Shared Style Preamble:**
  > `Commercial banking-grade enterprise UI icon, strict front-facing 2D orthographic view, restrained tactile flat design with matte archival paper and brushed metal finish, clean geometric shapes, subtle minimal paper-fold layering, low-saturation institutional palette, crisp defined silhouette, centered with generous even margin on a solid flat pure white #FFFFFF studio background.`
- **Shared Negative Guardrails:**
  > `No text, no letters, no numbers, no watermark, no isometric angle, no perspective tilt, no cartoon faces, no sparkles, no floating particles, no neon glow, no glossy glassmorphism, no heavy drop shadow outside the silhouette, no busy background.`
- **Why solid `#FFFFFF` background + non-white icon edges:**
  - Avoids green/magenta chroma spill halos common in diffusion/Imagen generation.
  - Because every paper/light surface uses archival off-white (`#e8ecee`) bounded by a slate hairline edge, border flood-fill matting + anti-aliased edge decontamination extracts razor-clean transparency for both Light and Dark themes.

### 5.2 Stage 1 — Style Anchor Sign-Off (3 Icons)

Generate only the **3 family anchors** first using `nano-pro` into a dedicated Flow project, inspect candidates, and approve 1 winner per family before running the remaining 24 icons:

```bash
# 1. Create a dedicated Flow project on the first anchor (record the returned project ID)
gflow image t2i "<prompt for file-folder>" \
  --model nano-pro --aspect 1:1 -n 2 \
  --project-name "ftp-master-icons-v1" \
  --out ./tmp/icon-gen/anchors

# 2. Generate the remaining two family anchors in the same project
gflow image t2i "<prompt for empty-upload>" \
  --model nano-pro --aspect 1:1 -n 2 \
  --project <PROJECT_ID> \
  --out ./tmp/icon-gen/anchors

gflow image t2i "<prompt for service-database>" \
  --model nano-pro --aspect 1:1 -n 2 \
  --project <PROJECT_ID> \
  --out ./tmp/icon-gen/anchors
```

**Draft Anchor Prompts:**
1. **`file-folder` (Family A anchor):**
   `Commercial banking-grade enterprise UI icon of a single upright closed archival file folder with a clean top-left index tab and subtle front pocket fold, warm muted archival brass-brown (#8c6223) back panel and slightly lighter matte manila-tan (#b88b47) front flap, crisp dark-bronze hairline edge, strict front-facing 2D orthographic view, restrained tactile flat finish, bold simple silhouette legible even at 16px, centered with generous margin on solid flat pure white #FFFFFF background. No text, no letters, no tilt, no glossy shine, no heavy shadow.`
2. **`empty-upload` (Family B anchor):**
   `Commercial banking-grade enterprise empty-state UI emblem of a neat open archival filing tray in cold matte slate (#4a585e) holding one aligned crisp off-white document sheet (#e8ecee) with a refined upward upload arrow emblem in archival deep teal (#12665b), strict front-facing 2D orthographic view, calm balanced geometric composition, restrained tactile matte flat style, centered with generous margin on solid flat pure white #FFFFFF background. No text, no letters, no cartoon characters, no sparkles, no floating dots, no neon glow.`
3. **`service-database` (Family C anchor):**
   `Commercial banking-grade enterprise infrastructure card icon of three neatly stacked matte cylindrical database storage tiers in institutional navy (#285c96) and cold slate (#4a585e) with subtle horizontal separator seams and tiny muted teal status indicators, strict front-facing 2D orthographic view, solid disciplined geometric weight, restrained tactile matte flat finish, centered with generous margin on solid flat pure white #FFFFFF background. No text, no letters, no perspective tilt, no glowing neon, no heavy shadow.`

### 5.3 Stage 2 — Anchor-Guided Batch Generation (`gflow run`)

Once the 3 anchor winners are saved locally (e.g., `anchors/file-folder.png`, `anchors/empty-upload.png`, `anchors/service-database.png`), generate the remaining 24 icons via `gflow run --config` in the same `--project` with `--resume` enabled for idempotent retries.

Config structure (matching `gflow run` schema):

```json
{
  "project": "<PROJECT_ID>",
  "output_dir": "tmp/icon-gen/batch",
  "prompts": [
    {
      "output_filename": "file-word",
      "model": "nano-pro",
      "aspect_ratio": "1:1",
      "count": 2,
      "ref": "anchors/file-folder.png",
      "text": "Match the exact visual weight, matte tactile flat finish, front-facing 2D orthographic style, and crisp silhouette of the reference icon. Draw a single upright document page in archival off-white (#e8ecee) with a slate hairline border, a small top-right folded corner, an institutional navy (#285c96) top accent strip, and three clean horizontal paragraph bars inside. Centered on solid pure white #FFFFFF background. No text, no letters, no tilt."
    }
  ]
}
```

Execution command:

```bash
gflow run --config tmp/icon-gen/batch.json --project <PROJECT_ID> --resume --continue-on-error
```

- Family A (13 remaining icons) references `anchors/file-folder.png`.
- Family B (4 remaining icons) references `anchors/empty-upload.png`.
- Family C (6 remaining icons) + Family D (`app-favicon`) references `anchors/service-database.png` (for `app-favicon`, prompt explicitly specifies a rounded-square deep-teal banking emblem).
- Keep raw generation artifacts under a gitignored working folder (`tmp/icon-gen/`) — commit only the finalized processed assets in `web/src/assets/icons/` (and favicon).

### 5.4 Stage 3 — Local Post-Processing & Visual Contact Sheet (`uv`)

Run a reproducible Python script via `uv run --with pillow --with numpy` (plus local `cwebp`) over the 27 curated raw PNGs:

1. **Matting & edge cleanup:** Corner-seeded flood-fill + luminance/distance alpha ramp around `#FFFFFF` backdrop, followed by edge color decontamination to eliminate white halo fringes on dark `#1d2122` backgrounds.
2. **Optical normalization:** Trim transparent bounds, scale to family target occupancy (`84%` for A/C, `80%` for B, `90%` for D) using Lanczos resampling, center on square canvas.
3. **Final asset export:**
   - Family A (14) & Family C (7): `128×128` transparent WebP (`-q 92 -alpha_q 100` or lossless if smaller) into `web/src/assets/icons/<iconId>.webp`.
   - Family B (5): `192×192` transparent WebP into `web/src/assets/icons/<iconId>.webp`.
   - Family D (1): `128×128` PNG (`web/src/assets/icons/app-favicon.png`) + `32×32` PNG (`web/public/favicon-32.png` or Vite-referenced asset in `web/index.html`).
4. **Automated QA Contact Sheet:** Generate a single local HTML preview sheet rendering all 27 final assets side-by-side on **Light (`#ffffff`, `#fbfcfc`)** and **Dark (`#1d2122`, `#191c1e`)** panels at exact runtime sizes (`16px`, `32px`, `36px`, `44px`, `60px`) for human sign-off before wiring into React components.

---

## 6. Frontend Component Architecture & Migration Map

### 6.1 New Icon Module Structure

```text
web/src/
├── assets/
│   └── icons/
│       ├── file-folder.webp
│       ├── file-folder-dropbox.webp
│       ├── ... (26 transparent .webp icons)
│       └── app-favicon.png
└── icons/
    └── AppIcon.tsx          # Typed manifest + unified <img> renderer
```

**`<AppIcon>` contract:**
- Static ES module imports for all 26 WebP icons (Vite content-hashes and bundles them reliably with zero broken runtime paths).
- Props: `name: AppIconName`, `size: number`, `className?: string`, `alt?: string` (defaults to `""` with `aria-hidden={alt === ''}`), `decoding="async"`, `draggable={false}`.
- CSS base rule `.app-icon`: `display: block; flex: none; object-fit: contain; user-select: none;` with crisp image scaling.

### 6.2 Component & CSS Touchpoints

| File | Change Summary |
| :--- | :--- |
| `web/src/FileIcon.tsx` | Expand format classification to cover all 13 `TreeNode` icon kinds (including `folder-dropbox` via `!(rights & 1) && (rights & 4)`, `folder-traversable` via `traversable && !rights`, `slides`, `text`, `video`, `audio`, `generic`). Render `<AppIcon name={...} size={tile ? Math.max(size, 28) : size} />`. Preserve `FileIcon` prop signature, `data-format`, `aria-hidden`, `fileTypeLabel`, and `formatSize` exports. |
| `web/src/RecycleBin.tsx` | Replace empty-state `<Trash2 size={25} />` with `<AppIcon name="empty-recycle" size={60} />`; replace item row `<FileX size={22} />` with `<AppIcon name="file-deleted" size={28} />`. |
| `web/src/TreePanel.tsx` | Replace writable empty state `<Upload size={24} />` with `<AppIcon name="empty-upload" size={60} />`; replace read-only empty folder & zero-search `<EmptyIcon size={24} />` with `<AppIcon name="empty-folder" size={60} />` / `<AppIcon name="empty-search" size={60} />`; keep error state (`failed`) on a danger `TriangleAlert`. |
| `web/src/RegistrationsPanel.tsx` | Replace empty-state `<Inbox size={26} />` with `<AppIcon name="empty-approvals" size={60} />`. |
| `web/src/HealthPanel.tsx` | Replace overview `<CheckCircle2>` / `<TriangleAlert>` with `<AppIcon name="health-ok" size={44} />` / `<AppIcon name="health-degraded" size={44} />`; replace service card `Database` / `HardDrive` / `Zap` with `service-database` / `service-storage` / `service-cache` (`size={36}`). Keep `.down` border/pill/alert outage signaling. |
| `web/src/UploadSettings.tsx` | Replace `ShieldCheck` / `Pencil` policy card header icons with `<AppIcon name="policy-upload-guard" size={36} />` and `<AppIcon name="policy-office-edit" size={36} />`. |
| `web/index.html` | Point `<link rel="icon" type="image/png" href="/src/assets/icons/app-favicon.png" />` (leave `PlatformBrand.tsx` header logo untouched). |
| `web/src/app.css` | Remove legacy background fill from `.icon-tile` (keep `32×32` centered flex/grid alignment box); remove `48px` `--control` box from `.empty-icon` so `60px` emblems sit cleanly; update `.health-status-icon`, `.health-service-icon`, and `.upload-policy-icon` so full-color `36–44px` icons render cleanly without double-boxing (retain subtle danger ring on `.health-service-card.down .health-service-icon`). |
| `web/src/fileDetails.css` | Adjust `.inspector-header .icon-tile` to cleanly frame the `36px` `FileIcon` without extra background tint. |

---

## 7. Verification & Acceptance Criteria

Before merging any generated icons into `web/`:

1. **Contact-Sheet Visual QA (Pre-Integration):**
   - All 27 icons display clean alpha transparency with zero white-halo fringing on `#1d2122` dark surfaces and zero edge disappearance on `#ffffff` light surfaces.
   - All 14 Family A icons remain clearly distinguishable at **`16px`** (sidebar tree) and **`32px`** (file list).
   - Zero embedded text artifacts, zero perspective drift across families, and consistent banking palette restraint.
2. **Desktop Browser Visual Acceptance (Light & Dark Themes):**
   - File Explorer: normal folder, drop-box folder, traversable folder, Word/Excel/PPT/PDF/Text/Image/Video/Audio/Archive/Generic rows, sidebar directory tree, inspector dialog, viewer header, grants header, empty upload state, empty read-only state, empty search state.
   - Recycle Bin: populated deleted rows (`file-deleted`) and empty state (`empty-recycle`).
   - Admin Views: Registrations empty state (`empty-approvals`), Health Panel (`health-ok` / `health-degraded` + 3 service cards in up/down states), System Settings (`policy-office-edit` + `policy-upload-guard`).
   - Browser tab: `app-favicon` crisp at `16px` tab size.
3. **Automated Quality Gates:**
   - `cd web && pnpm build` (`check:api`, `tsc -b`, `check:clock`, `vite build`) passes with zero warnings/errors.
   - `cd web && pnpm test:unit` passes.
   - Relevant desktop Playwright E2E specs (`tree.spec.ts`, `office.spec.ts`, `permissions.spec.ts`, etc.) pass with zero selector regressions.
   - Asset payload budget: total processed icon bundle across all 27 files stays lightweight (target `< 250 KB` total).

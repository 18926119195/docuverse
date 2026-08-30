# DOCUMVERSE Demo — 工程师交接说明

> 给另一位程序员快速读懂本 demo 的**设计意图、实现亮点、怎么跑、改哪里**。  
> 日期：2026-08-06 · 技术栈：React 19 + R3F/Three + Zustand + pdf.js + Vite  
> 仓库路径：`docuverse/`（本文件与源码同级）

---

## 1. 一句话它是什么

把 PDF 页铺成 **Ted Nelson 式「文档宇宙」球面**：用户在页上**圈强调**、用**星图建联**、进入 **A–B–C 构建镜头**（中点上升 → 穿洞 → 拉链共面），在评论点 C 写注释。  
数据身份在页内相对坐标；球面 / 机位只是渲染与布局。

专利对照（见 `README.md`）：

- US2012/0137202 — CVS 探索页间连接（前端 `src/cvs/*`）
- US2013/0174003 — ZigZag 交错（`src/zigzag/*`）

---

## 2. 必看设计：三层数据单元

实现注释集中在 `src/cvs/surfaceGeometry.ts` 文件头。

| 层 | 含义 | 存什么 / 算什么 |
|----|------|-----------------|
| **内在层（语义）** | 页是曲面片上的内容域 | `page_norm_0_1000` 多边形、`EmphasisEdge`、`EmphasisLink` |
| **嵌入层（几何）** | 如何嵌进同心球宇宙 | A/B 内球面点、测地中点 M、评论 C 在外同心球 |
| **渲染层（代理）** | 给人看、好点的假象 | `PageMesh` 平面卡片、billboard、拉链临时位姿 |

**交接重点：** 换 UE / 云串流时，尽量只换第 3 层（偶尔重写第 2 层实现），**第 1 层 JSON 语义应保持稳定**，便于以后接 API / MySQL。

当前持久化：**浏览器 `localStorage`**（尚无 MySQL）。键前缀：

- `docuverse.emphasis.v1:{corpus}:{label}`
- `docuverse.bonds.v1:{corpus}:{label}`

---

## 3. 核心用户流程（验收用）

### 3.1 导入 PDF

- UI：`PdfUploadPanel` → `importPdfFile`（pdf.js，最多约 80 页）→ `applyUploadedUniverse`
- **导入后标注从空开始**（不复用旧 localStorage 标注）
- 「清空标注」：`clearWorkspaceAnnotations`

### 3.2 强调笔（圈注）

| 键 / 操作 | 行为 |
|-----------|------|
| **H** | 开关强调笔 |
| 瞄准页 | 选中可画页（aim，不应用 thrash swoop） |
| **左键拖** | 落笔；GPU 缓冲实时墨迹 |
| 自交或靠近起点 | 封环 → `EmphasisEdge` |

实现亮点：

- `liveInkGpu.ts` + `LiveInkTrail.tsx`：**笔画热路径写 GPU**，每帧最多一次 `invalidate`（不是每点一次 `gl.render`）
- `EmphasisPenController.tsx`：落笔冻结页姿态，避免 UV 漂移
- `pageSurfaceRegistry.ts`：页拾取注册表；笔模式下页优先于拉链

### 3.3 建联（紫线）

**Enter 只锁 A，不会单独完成建联。**

1. **H 关笔**
2. 左键选中一个强调（或星图点星）
3. **Enter** → `emphasisLinkFromId = A`（星图提示「A 已锁定」）
4. 再点另一个强调 B → `createEmphasisLink` → **自动 `enterConstructionLens`**

入口：`KeyboardNav.tsx`、`EmphasisStarMap.tsx`、`EmphasisOverlay.tsx`。

### 3.4 构建镜头（demo 最大亮点之一）

阶段（`constructionStage`）：

1. **rail** — 中点沿 M→C 上升（可拖 / ↑中点）
2. **crossing** — 穿洞动画
3. **planar** — 两页拉链共面；**G** 评论层隐身/现身

评论层在 **C**：

- 非受控 `<textarea>`（浏览器原生输入，零 React 每键重渲染）
- IME：`compositionstart/end` 期间不写 store
- debounce / blur 才 `updateEmphasisLinkNote` + localStorage

文件：`RelationPasteLayer.tsx`、`constructionCamera.ts`、`ConstructionLensControls.tsx`。

### 3.5 其它

- 右下角 **星图**：建联导航（`frameloop="demand"`）
- **OCR / 永久绑定 / 用户射线**：`Ocr*`、`bonds.ts`
- **Agent 面板**：按评论等搜强调（需相关 API 配置时可用）
- **四面体全览**：辅助机位（`emphasisTetrahedron.ts`）；非建联主路径，可删不影响圈注/建联

---

## 4. 实现亮点清单（建议演示时强调）

1. **语义与渲染分离** — `page_norm` 真数据；球 / 平面代理可换引擎  
2. **强调笔低延迟** — GPU ink trail + 单帧 invalidate  
3. **建联状态机清晰** — A→B → 自动进构建，几何与交互绑在一起  
4. **球面关系几何** — A/B 内球、C 外球、测地中点（`constructionCamera` / `surfaceGeometry`）  
5. **评论层输入体验** — 非受控 + IME 保护（曾踩过受控 value 打断拼音的坑）  
6. **瞄准不搅动宇宙** — aim 选页不 thrash `currentStrand` / 避免页「冲向相机再弹回」  
7. **可逆构型** — 漫游 ↔ 构建 ↔ 回溯；底稿标注不毁 PDF  

---

## 5. 目录地图（改代码从这找）

```
docuverse/src/
  cvs/                    # 3D 宇宙与构建
    store.ts              # Zustand 全域状态（最大文件）
    CvsScene.tsx          # R3F Canvas
    PageMesh.tsx          # 页卡片
    surfaceGeometry.ts    # 三层转换（必读）
    constructionCamera.ts # 构建几何与镜头
    EmphasisPenController.tsx / liveInkGpu.ts
    RelationPasteLayer.tsx  # 拉链 + 评论 C
    EmphasisBeamLayer.tsx   # 紫线
    EmphasisOverlay.tsx     # 页上线圈
    emphasisTetrahedron.ts  # 可选四面体机位
  data/
    emphasis.ts           # Edge/Link 类型、封环、centroid、localStorage
    pdfImport.ts          # PDF → 页图
    bonds.ts              # OCR 永久绑定
    emphasisAgent.ts      # Agent 检索
  ui/                     # HUD、星图、工作台、键盘
  zigzag/                 # EDL / 专利数据结构
```

---

## 6. 关键类型（给接 API / UE 的人）

```ts
// 强调 = 图上的节点
EmphasisEdge {
  id, strandIndex, sourcePage?,
  region: { polygon: PagePoint[], aabb },  // page_norm 0..1000
  reading?, createdAt, ...
}

// 建联 = 边
EmphasisLink {
  id, fromEmphasisId, toEmphasisId,
  note,                    // 评论层文本
  commentCenter,           // 外球 C 的几何见证（可派生）
  apex?, createdAt
}
```

`PagePoint = [nx, ny]`，归一到页宽高 0–1000。

---

## 7. 怎么跑

```bash
cd docuverse
npm install
npm run dev          # http://127.0.0.1:5173/
# 或生产预览：
npm run build && npm run preview -- --host 127.0.0.1 --port 5173
```

建议验收路径：上传 PDF → H 画两个圈 → 关笔 → 选 A → Enter → 星图/页点 B → 构建中升中点 → 穿洞 → G 开评论 → 拼音输入几句。

**注意：** 多开 Vite / 旧 `dist` 缓存会导致「改了却看不见」；验收时确认端口上是当前 build，硬刷新。

---

## 8. 已知边界 / 非目标（当面说清）

| 现状 | 说明 |
|------|------|
| 无 MySQL / 无云 API | 仅 localStorage；云端是下一步 |
| 弱机 / 手机满血 80 页球面 | 未按手游资源管线优化；流畅需 CDN 页图、demand 渲染或云串流 / UE |
| 四面体 | 辅助浏览，非核心 |
| 主 Canvas | 持续渲染（星图已是 demand）；性能优化空间大 |

设计者意图（背景）：语义可逆、可接 HoTT 式「等同 / 复合」的长远方向；**当前构建器实现仍以矢量几何为主**，类型论是构型规则层面的隐喻，尚未形式化 path 类型。

---

## 9. 建议下一任工程师的切入点

**小改体验：** `RelationPasteLayer` 评论、`EmphasisPenController` 笔、`KeyboardNav` 快捷键。  
**接云端：** 抽 `persistEmphasis` / `loadEmphasisState` 为 HTTP；页图改对象存储 URL；表结构对齐 §6。  
**接 UE：** 冻结 §6 schema + `surfaceGeometry` 嵌入约定；UE 只重做渲染代理。  

---

## 10. 演示话术（30 秒）

> 我们把 PDF 切成球面上的页，但**真数据是页内坐标上的强调和连线**。  
> 圈注走 GPU 墨迹所以跟手；两点建联后进入专利味的构建：中点爬到评论球，穿洞后两页拉链共面，在 C 点写字。  
> 球可以换成别的引擎；圈和线可以进数据库——**语义层已经分开了。**

---

*本文件为 demo 交接专用。运行问题优先查 `package.json` scripts 与 §7。*

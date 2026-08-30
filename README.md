# DOCUMVERSE — Ted Nelson 文档宇宙

按两份专利一比一实现：

| 专利 | 角色 | 代码入口 |
|------|------|----------|
| US2012/0137202A1 System for Exploring Connections Between Data Pages | 前端 CVS | `src/cvs/*` `src/zigzag/edl.ts` |
| US2013/0174003A1 System for Combining Datasets by Intercalation | 数据 ZigZag | `src/zigzag/space.ts` `intercalation.ts` |

GLM-5V-Turbo 附图规格：`../patent-ocr/glm-frontend-spec.md`、`glm-data-spec.md`

## 本机运行（推荐自测）

```bash
git clone https://github.com/18926119195/diergbanben-fanout.git
cd diergbanben-fanout/docuverse
npm install
npm run dev
```

在本机浏览器打开 http://127.0.0.1:5173/（**不是** Cloud Agent Preview）。

一键脚本：`./scripts/setup-local.sh`（Windows：`.\scripts\setup-local.ps1`）

完整说明：[../docs/LOCAL_SETUP.md](../docs/LOCAL_SETUP.md)

### 扇出试点快速测

1. 上传扫描 PDF（不勾选「有文字层」）→ 等索引就绪  
2. 右侧扇出 HUD 提问 → 打开写信台 → 确认执行  
3. 查看多路径、监督 Δ、双闸、采纳/reuse  

设计文档：`../docs/扇出改造-设计共识与接续手册.md`

## 专利导航键（CVS）

- `C` / `E` — 当前页上一条 / 下一条连接（swoop）
- `F` — 进入伴页（companion → current）
- `S` — 交换主页与伴页
- `↑↓` — sworf 缩放
- `←→` — 水平环视
- `Z` — 切换 ZigZag 交错面板

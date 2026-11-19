# Docuverse 入库指南

这里是沿问题键推进、复用和监督的 Docuverse 版本。新协作者用一个问句追完 `queryKey → 可用材料 → path → 采纳或监督`，再从失败点切入。此页核对 [main · a7b57d7](https://github.com/18926119195/docuverse/commit/a7b57d78b66a98034f13f437c6a43d3dccad4bc6)，对应已合并的 [整理 PR](https://github.com/18926119195/docuverse/pull/1)。

## 首次进入

- [运行和维护入口](MAINTAINERS.txt) 说明仓库边界。[开发时间线](DEVELOPMENT_HISTORY.txt) 的 DV-01 至 DV-06 将作者原话、Git 提交和代码行逐项关联。
- 从 [A1ChatDock](src/ui/A1ChatDock.tsx) 追到 [autoFlow](src/reasoning/autoFlow.ts)，通过 [attentionIoStore](src/reasoning/attentionIoStore.ts) 看同问复键与台账。打开 [gapNavigation](src/arch/gapNavigation.ts) 理解已有复用时的下一步。
- 改监督先读 [superviseCritique](src/reasoning/superviseCritique.ts) 的归因和 [superviseCritiqueExec](src/reasoning/superviseCritiqueExec.ts) 的动作。改部署从 [本地 Vite](vite.config.ts) 和 [后端说明](docs/VERCEL_BACKEND.md) 进入。

## 已有能力与证据边界

| 聊天节点 | 代码证据 | 本次核对 |
| --- | --- | --- |
| 9 月 3–4 日 DV-01/02，内禀坐标、同问复键和空位导航。 [会话索引](docs/chat-archive/README.md) | [铸键](src/arch/settleMint.ts) 逐个核验 prospect 行。普通链使用 [BM25](src/reasoning/retrieveBm25.ts)，先查已登记的 queryKey。 | 离线验证同问键、排名和复用登记后推进到 brief。模型选材质量待实测。 |
| 9 月 7 日 DV-03/04，复用失败保留当前问与证据，监督拆为预测与推理。 [会话原件](docs/chat-archive/2026-09-07-letter-desk-supervise.jsonl) | [letterDeskDispatch](src/reasoning/letterDeskDispatch.ts) 提供排除 brief，推理轨在有既有 inferKey 和材料时复用材料，预测轨可进入 decide。 | 已接动作执行器。两轨的真实调度和错误归因比例待验证。 |
| 9 月 7 日 DV-05，换问、坏路径与文本同构分别处理。 [两轨会话](docs/chat-archive/2026-09-07-supervise-dual-track.jsonl) | [监督执行器](src/reasoning/superviseCritiqueExec.ts) 接 `revise_q`；[同构闸](src/reasoning/prospectIsomorph.ts) 处理文本重复。 | 夹具断言文本同构。坏路径排除、保留其他路径、完整重问链尚缺同一端到端验收。 |
| 11 月 19 日 DV-06，落账纠正和三态。 [整理提交](https://github.com/18926119195/docuverse/pull/1) | [gapNavigation](src/arch/gapNavigation.ts) 用 `fromQueryKey` 查现问采纳边，[三态归一](src/arch/keyIncrementStatus.ts) 优先处理明确否定。 | 实测“充分”“不充分”“未读”等在既有测试中的状态正确。 |

## 运行和控制闭环

```sh
npm ci --ignore-scripts
npm run build
npm run check:system
npm run dev
```

本次用 Node 24.22.1 实跑安装、生产构建和 [离线系统检查](scripts/check-system.mjs) 均通过，Vite 有包体提示，实测范围为本地确定性夹具。`dev` 是进入界面的命令。真实 OCR、真实模型、浏览器全过程和生产配置待复核。

1. **固定输入与责任**。选一份可共享文档、一个现问、两条历史路径和一个复用确认动作。工程协作者保存提交、`queryKey`、历史 path、三态、实际调用与下一跳。维护者确认同问合并、坏路径与相似文本判据。
2. **先补监督场景**。用 Mock 让一次复用成功后推进、一次只排除指定坏 path、一次触发 `revise_q`。验收要求同问键保持一致、未批准的路不进入已采纳记录、指定坏 path 不复用，推理轨只重跑约定的 infer。通过后用批准的真实输入记录延迟与模型分歧。
3. **通过偏差调试**。分清文本重复、材料不足和推理归因，先用固定输入找首个错误转移。维护者按同一夹具验证修正或回退，并将结果附到相应 DV 编号和 PR。讨论中新增的 Key 或状态必须有一个可观测的落账点。

## 方法依据

本指南把总体设计落实为边界、目标和任务接口，把工程控制中的反馈落实为观测、判据和纠偏。维护者用原始协作记录、代码和固定样本共同核验定性判断与量化结果，据此决定下一轮行动。[《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics) · [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《一个科学新领域——开放的复杂巨系统及其方法论》](https://cnki.istiz.org.cn/kcms/detail/detail.aspx?dbcode=CPFD&dbname=cpfd1999&filename=ZGXC199008001001)

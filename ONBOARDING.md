# Docuverse 入库指南

[一分钟定位](#一分钟定位) · [沿聊天时间线看灵感](#沿聊天时间线看灵感) · [从代码反查来由](#从代码反查来由) · [走读与维护记录](#走读与维护记录)

## 一分钟定位

这是把读书问答当作一条可回查的问线来组织的 Docuverse。问题登记为 `queryKey`，材料和推理形成路径，确认或反馈会决定下次从旧路径复用、补材料还是改变推理方向。阅读基线为 [main · a7b57d7](https://github.com/18926119195/docuverse/commit/a7b57d78b66a98034f13f437c6a43d3dccad4bc6)。[维护入口](MAINTAINERS.txt) 可比较相近实验，[开发沿革](DEVELOPMENT_HISTORY.txt) 保留原话和历史版本的行级链接。

## 沿聊天时间线看灵感

**如何读状态。** 已实现表示在所列版本找到与灵感相符的代码路径。部分实现表示已有其中一段。未实现表示已查的入口尚无对应实现。证据不足时标待确认。归档与设计文稿按资料本身的状态描述。

下表用北京时间。常见入口从 [A1ChatDock](src/ui/A1ChatDock.tsx) 进入 [autoFlow](src/reasoning/autoFlow.ts)，也可从手动 [FanoutHud](src/ui/FanoutHud.tsx) 进入写信台。

| 编号与聊天原件 | 当时提出的思路 | 当前状态与代码证据 |
| --- | --- | --- |
| <a name="idea-i01"></a>I01 · 9 月 3 日 10:27，[架构原件 L1](docs/chat-archive/2026-09-03-architecture-align.jsonl#L1) | 书页给出空间来由，职责和工作步骤给出产生 key 的环节。 | **部分实现。** 台账记录推理生成的键和材料来源。聊天里的完整时空模型尚没有统一实现依据。 [早期问线台账](https://github.com/18926119195/docuverse/blob/bdd46a7056cac8d0d9475004cd5bafef88a931bc/src/reasoning/attentionIoStore.ts#L50-L89) · [现有台账](src/reasoning/attentionIoStore.ts) |
| <a name="idea-i02"></a>I02 · 9 月 4 日 10:53，[续谈 L56](docs/chat-archive/2026-09-04-architecture-continue.jsonl#L56) | 去掉普通问答的检索漏斗，让同问能从已登记位置继续。 | **已实现普通路径。** 同问先复用 queryKey，空位导航查询已落账状态，普通检索使用 BM25。整理修复之后，复用确认能推进到 brief。 [空位导航](src/arch/gapNavigation.ts) · [BM25](src/reasoning/retrieveBm25.ts) · [离线检查](scripts/check-system.mjs) |
| <a name="idea-i03"></a>I03 · 9 月 4 日 11:00，[续谈 L67](docs/chat-archive/2026-09-04-architecture-continue.jsonl#L67) | 新增内容按槽铸键，避免把两项本该独立的内容合到一键。 | **已实现按槽登记。** settleMint 依据允许的输入逐个核验 prospect 行，生成的键入问线台账。 [铸键](src/arch/settleMint.ts) · [实现提交](https://github.com/18926119195/docuverse/commit/463729c1b0c4b907f9a0148a00ce7aaed2cce635) |
| <a name="idea-i04"></a>I04 · 9 月 7 日 12:45–12:46，[写信台讨论 L31–35](docs/chat-archive/2026-09-07-letter-desk-supervise.jsonl#L31-L35) | 复用失败时说明应排除哪些历史材料，保留当前问与可用证据。 | **已实现材料排除。** 复用返回排除 brief，自动流在 decide 之前取用。 [历史调用点](https://github.com/18926119195/docuverse/blob/b59600ec31e2800362d6dc60e90e36a631523d61/src/reasoning/autoFlow.ts#L466-L490) · [当前写信台执行](src/reasoning/letterDeskDispatch.ts) |
| <a name="idea-i05"></a>I05 · 9 月 7 日 14:00，[监督讨论 L116](docs/chat-archive/2026-09-07-letter-desk-supervise.jsonl#L116) | 材料已经够用时，监督只改变推理方向；选材问题走另一条轨。 | **已实现两轨分派。** 代码有归因与分派，推理轨使用留存材料，预测轨可进入 decide。真实模型的归因与两轨完整走读未在本次验证。 [归因](src/reasoning/superviseCritique.ts) · [分派](src/reasoning/superviseCritiqueExec.ts) |
| <a name="idea-i06"></a>I06 · 9 月 7 日 15:50，[两轨讨论 L52](docs/chat-archive/2026-09-07-supervise-dual-track.jsonl#L52) | 分清换问题、排除一条坏路径与回避重复的方向表述。 | **已实现动作分支。** `revise_q` 可回标准流程，同问可禁指定旧路径，文本同构有独立判断。离线只直接覆盖了文本闸等确定性环节。 [两轨历史提交](https://github.com/18926119195/docuverse/commit/9d263db3b875ff4fc6dc3039e5c3415a42eaeca0) · [同构代码](src/reasoning/prospectIsomorph.ts) |

11 月 19 日的整理 PR 更新代码、三态和索引，应按代码版本查阅；其提交时间可以和原始思路的会话时间分开阅读。 [整理 PR](https://github.com/18926119195/docuverse/pull/1)

## 从代码反查来由

- [attentionIoStore](src/reasoning/attentionIoStore.ts) 与 [settleMint](src/arch/settleMint.ts) 回看 [I01](#idea-i01)–[I03](#idea-i03)，先区分问题的身份与后续产生的路径。
- [gapNavigation](src/arch/gapNavigation.ts) 回看 [I02](#idea-i02)。改复用查现问的 `fromQueryKey` 和已登记路径。
- [letterDeskDispatch](src/reasoning/letterDeskDispatch.ts) 回看 [I04](#idea-i04)、[I06](#idea-i06)。选材排除与禁止复用某条旧 path 分开处理。
- [superviseCritiqueExec](src/reasoning/superviseCritiqueExec.ts) 回看 [I05](#idea-i05)–[I06](#idea-i06)。读入口分派后，再到被选择的动作。

## 走读与维护记录

如果第一次接触 `queryKey`，先读 [离线复用夹具](scripts/check-system.mjs)，比较登记前的 `reuse` 和登记后的 `brief`，再对照 [I02](#idea-i02) 的空位导航原意。本次 Node 24 下安装、生产构建和 `npm run check:system` 通过，真实 OCR、模型与生产部署的验证范围仍独立。发现聊天、源码或运行结果出现分歧时，把原件行、所查版本与实测行为附在同一个 I 编号下。

**指南如何更新。** 以仓库和版本划定范围，从聊天提取原始目标，再用代码与产物校正对当时决策的理解。新证据出现时，回到原编号修订记录。这种读法借鉴了钱学森的系统工程和工程控制论。 [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics)

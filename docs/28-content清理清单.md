# 28 · `content/` 素材清理清单（B-55）

> **【2026-09-25 已执行】** 第 3.1、3.2 节所列三项（oc-kaleidos / oc-kosmos / weekly-meme-report，共 686K）已删除；
> AGENTS.template.md 的「角色沙盘」行已同步移除。备份在 `D:/tmp/novel-content-backup/`，
> 且 git 历史可随时恢复（`git revert` 或 `git checkout e056b54 -- content/skills/<名>`）。
> **原清单正文保留如下，供追溯判断依据。**
>
> 原始说明：本文档最初只列清单未删除（等作者确认）；作者于 2026-09-25 确认删除。 删什么、留什么是作者的决定——
> `content/` 里装的是随插件分发的能力资产，不是代码，删掉不会有编译错误提醒你。
> 确认后告诉我删哪些，我再动手（并先做一次备份）。
>
> 生成于 2026-09-25，基于当时仓库实际内容与引用面扫描。

## 1. 总览

```
content/rules       68K    本书规则与风格（与写作链路直接相关）
content/skills     1.1M    技能包 —— **本次清理的主要对象**
content/templates   67K    书目录模板（AGENTS/book.json 等）
content/workflows   32K    工作流
```

`content/skills/` 的 13 个技能包，按与「中文长篇网文写作」核心链路的关系分三档。

## 2. 保留（与核心链路直接相关）

| 技能 | 体积 | 为什么留 |
|---|---|---|
| `chinese-punctuation` | 8K | 标点规范，正文后处理直接用 |
| `conflict-design` | 8K | 冲突设计（B-11 判据之外的创作辅助） |
| `pacing-control` | 8K | 节奏控制 |
| `protagonist-design` | 8K | 主角设计 |
| `golden-three-chapters-review` | 16K | 黄金三章审稿（开篇质量的核心判据） |
| `humanizer-webnovel-cn` | 28K | 去 AI 味 |
| `fanqie-publish-assistant` | 36K | 番茄发布（平台导出） |
| `trope-retrieval` | 104K | 套路检索（卡文时用；体量大但直接服务于写作） |

## 3. 候选清理（建议删，请确认）

### 3.1 `oc-kaleidos`（319K）+ `oc-kosmos`（323K）—— 合计 **642K，占 skills 的 58%**

**是什么**：OC（原创角色）沙盒世界导演。`oc-kosmos` 是实时推进时间（默认 1:10），
`oc-kaleidos` 是剧情驱动时间（用户不在时暂停）。含人物卡、关系表、心理模型、
时间线、对齐度计等一整套独立体系。

**为什么建议删**：
- 它与「写长篇网文」是**两种不同的玩法**——一个是「和一个角色持续互动」，
  一个是「把一本书写出来」。前者有自己的 `Knowledge/` 目录结构与状态文件，
  与 novel-engine 的 `chapters/` + `state/` 体系**没有交集**。
- 体积占了 skills 的一半以上，而一次都用不到。
- 如果确实要用 OC 沙盒，它更适合作为**独立的 skill 安装**，而不是塞在写作引擎仓里。

**删了会牵动什么**：
- `content/templates/AGENTS.template.md:240` 有一行 `| 角色沙盘 | oc-kosmos / oc-kaleidos |`
  —— 需要一并删掉该行。
- `docs/03`、`docs/09` 有提及（旧手册存档，按惯例不改）。

### 3.2 `weekly-meme-report`（44K）

**是什么**：热梗周报（抓抖音/B站评论区的自发玩梗）。

**为什么建议删**：
- docs/24 P1-2 已明确点名它是「无关或过期资产」。
- 与写作链路无交集；真要追热点，它是一个独立的内容运营工具。

**删了会牵动什么**：仅 `docs/09`、`docs/24` 的提及（存档，不改）。

### 3.3 `wuhang-long-all`（133K）+ `wuhang-long-chaijie2`（56K）—— 189K

**是什么**：武行全流程 kit（`1-边界确定` → `2-创意与设定` → `3-大纲` → `4-正文` → `5-审查`）
与拆书 kit。**这是你现在的实际工作流来源**。

**⚠️ 不建议删**，但**列在这里请你确认**：
- 它的脚本绑死阶段目录相对路径（`1-边界确定/`、`4-正文/`），按项目 MEMORY 的既有裁决
  「武行 kit 是 kit 私有，不得迁入 tools/」。
- 它与 novel-engine 的 `novel plan` / `novel write` 在**功能上重叠**（都做逐层建书与正文），
  这是 docs/24 P1-1「三套同类系统并存」的一部分。
- **要不要收拢、以及收拢到哪一边，是架构决定，不是清理决定。** 需要你单独定。

## 4. 需要你决定的三件事

1. **`oc-*` 与 `weekly-meme-report` 是否删**（合计 686K）。删的话我顺带处理
   `AGENTS.template.md:240` 那一行。
2. **`wuhang-*` 与 novel-engine 的 `plan`/`write` 功能重叠**怎么处置——
   这是 docs/24 P1-1（B-54）的范围，不是本次清理能定的。
3. **`content/workflows/` 是否还有用**（32K，本次未逐项核）。需要的话我另出一份清单。

## 5. 清理纪律（动手时遵守）

- 删之前**先备份**（`cp -r content/skills/<name> <备份目录>`），并告诉你备份在哪。
- **只删本次确认的项**，删除命令单独成行、写全名（项目既有纪律）。
- 删完跑一遍 `node tools/find-orphan-exports.mjs` 与全量测试，确认没有引用悬空。
- 更新 `README.md` 与 `docs/09-规则清单.md` 里对应的行。

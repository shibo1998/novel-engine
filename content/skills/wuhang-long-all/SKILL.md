---
name: wuhang-long-all
description: Run Wuhang's full long-form web novel pipeline—project init, boundary analysis, ideation, outline, writing, and optional review checkpoints. Use when the user asks for 武行全流程, 武行长篇全流程, long web novel workflow, loading the Wuhang novel kit, or initializing a new long-novel project.
---

# 武行·长篇小说流程 Kit（全流程入口）

> ## ⚠️ 本项目适配说明（novel-writing）
>
> 本技能包**源自灵蟹创作**，路径与目录名沿用其旧结构。本项目（novel-writing）是另一套结构，
> **读到「项目根目录」的下列路径时，按此表映射**：
>
> | 技能里提到的项目目录 | 本项目实际位置 |
> |---|---|
> | `1-边界/` | `1-边界/`（同名） |
> | `2-设定/` | `world/` ＋ `characters/` ＋ `.soloent/constitution/MASTER.md` |
> | `3-大纲/` | `outline/` |
> | `4-正文/` | `chapters/` |
> | `5-审查/` | `notes/` ＋ `review/` |
> | `.soloent/**` | 同名（路径已适配：`MASTER.md`／`now.md`／`伏笔回收总表.md`） |
>
> ⚠️ **注意区分**：技能包**内部**的 `1-边界确定/`、`2-创意与设定/`、`3-大纲/`、`4-正文/`、`5-审查/`
> 是**本技能自己的子目录**，不需要映射；只有「项目根目录」下的同名目录才映射。
>
> **权威来源**：全局入口是插件根目录的 `SKILL.md`（场景 A/B/C）；
> **每章流程以 `docs/06-正文.md` 为准**（本技能包的第六/七步是它的来源之一）。

## 触发词

用户说以下内容时，可加载本 SKILL 进入全流程模式：
- **武行全流程** / **武行长篇全流程**
- **我想写一本长篇网络小说** / **我想写长篇**
- **我想写一本小说**（并确认为长篇）
- **加载武行小说技能包** / **项目初始化**（从零开始写长篇时）

**只做某一阶段？**  
用户若只明确某一阶段（如「我只要写大纲」），不要走全流程，提示其直接加载对应阶段的 `SKILL.md`。

---

## 执行顺序

**第零步：项目初始化**

> ⚠️ **本项目不要手动建目录、不要手抄模板**——用插件的初始化脚本，一条命令建全：
>
> ```bash
> python "<插件>/scripts/init_book.py" --dir "<书目录绝对路径>" \
>     --title "书名" --genre "题材" --platform "平台" --tags urban,system \
>     --words 2400 --length "100 万字以上"
> ```
>
> 它生成的是**本项目标准结构**：`chapters/ characters/ world/ outline/ notes/ review/ 1-边界/`
> ＋ `.soloent/{memory,constitution,rules}`，以及 `book.json`、`SOLOENT.md`、`AGENTS.md`、`tools/` 薄壳。
> 详见 `docs/01-初始化.md`。

若已存在 `SOLOENT.md` 及标准目录结构，跳过本步，直接进入第一步。

<details>
<summary>原灵蟹版初始化步骤（本项目已由 init_book.py 取代，保留备查）</summary>

- 在项目根创建目录：`1-边界`、`2-设定`、`3-大纲`、`4-正文`、`5-审查`、`.soloent/constitution`、`.soloent/memory`。
- 从本技能包 `1-边界确定/docs/` 读取并写入项目：
  - `SOLOENT.md` → 项目根目录
  - `MASTER.md` → `.soloent/constitution/MASTER.md`
  - `TEMPLATE_CHARACTER_STATE.md` → `.soloent/memory/now.md`
  - `TEMPLATE_FORESHADOWING.md` → `outline/伏笔回收总表.md`
  - `expectation_template.md` → `1-边界/预期.md`
- 若技能包根目录有 `武行-长篇小说技能说明书.md`，可复制到项目根供用户查阅。

</details>

**第一步**：读取并执行 `1-边界确定/SKILL.md`
→ 样板书拆解，产出 1-边界/ 系列文件。完成后继续。

**第二步**：读取并执行 `2-创意与设定/SKILL.md`
→ 脑暴、设定案、角色表、宪法。完成后继续。

**第三步**（可选）：读取并执行 `5-审查/SKILL.md`
→ 对当前设定做质检，发现问题回到第二步修正，确认无误后继续。

**第四步**：读取并执行 `3-大纲/SKILL.md`
→ 总纲、卷纲、章纲。完成后继续。

**第五步**（可选）：读取并执行 `5-审查/SKILL.md`
→ 对大纲做质检，确认无误后继续。

**第六步**：读取并执行 `4-正文/SKILL.md`
→ 按章写作，本卷完成或剧情偏离时回到第四步修订或开写下一卷。

**第七步**（**每章后强制**，不可跳过）：读取并执行 `5-审查/SKILL.md`
→ 正文质检（模块 3）／设定回溯，发现问题回对应阶段修正。
⚠️ **不是可选项**：闸门只管算得出来的硬伤（人名／年份／刻度／字数／黑名单词），
**AI 句式结构、人味、钩子质量全靠这一步**。跳过它，正文只过了一半的关。
（本项目每章循环的完整定义见 `docs/06-正文.md` 第 6–7 步。）

---

> 若用户只明确说了某个阶段（如「我只要写大纲」），请停止执行本全流程，提示用户直接加载 `3-大纲/SKILL.md`。

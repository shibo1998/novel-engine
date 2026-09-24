# 22 · 风格/红线层前置闸门接线 + init 回归修复（2026-09-24）

> **本轮做的是 `docs/21` 第 4 节「修正后的执行建议」的第 1–3 步**，外加核验过程中
> 新翻出的三处「守卫在但不生效」。
> **一句话结论**：把一套**写好了却零调用者**的风格守卫接进了真正会发生生成动作的入口；
> 同时把 `novel init` 在迁仓时丢掉的三份风格文件补了回来。
> 验证：`pnpm -r build` / `-r run typecheck` 通过；core 测试 **53 项全绿、0 跳过**（此前是 45 通过 / 8 跳过）。

---

## 1. 改动清单

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `gates/kit.py` | `TEMPLATES` 指向 `content/templates`（原指向不存在的 `<仓根>/templates`） | 模板比对外面套着 `isfile` 守卫 → **「与模板一字不差」这条判据一直是死分支**，不报错也不生效 |
| `gates/kit.py` | `style_doc_issues`：文件「缺失或为空」由 `warn` 升为 `block` | 对下游而言「有占位符」与「文件缺失」完全等价（都是零文风依据），却只有前者拦人 → **删文件即可绕过闸门** |
| `gates/kit.py` | `style_gate_ready`：就绪判据由「没有 block」改为「**一条 issue 都没有**」 | 同上，第二道独立防线；并写明级别只是「原因类别」，不代表是否拦截 |
| `gates/kit.py` | `PLACEHOLDER_MARKS` 补全角 `"待填）"` | 原词表只收半角 `"待填)"`，而 `novel init` 写进 `canon.md`/`now.md` 的恰恰是**全角**「（待填）」——最常见的占位写法反而不在词表里 |
| `gates/kit.py` | 找不到书配置的提示：`init_book.py` / `assets/book.example.json` → `novel init` | 两个路径在本仓都不存在，用户照提示做必然扑空 |
| `gates/style_doc_check.py` | **新增**：把 `kit.style_doc_issues`/`style_gate_ready` 接进 gates 契约（只读，stdout 只留 JSON） | 守卫本体的唯一来源仍在 kit；本文件只做「调用 + 契约适配」，**不重写判据**（避免第二份副本漂移） |
| `packages/core/src/style.ts` | **新增**：`runStyleGate` / `assertStyleReady` / `StyleNotReadyError` | 复用既有 `runGates` 的 spawn 机制，零新增子进程代码；`ready` 与 `findings` 做**交叉校验**，两处口径不一致即抛错 |
| `apps/cli/src/commands/init.ts` | 落 `story-style.md` / `MASTER.md` / `1-边界/预期.md` 三份待填模板 + 新建 `1-边界/`；book.json 补 `checks` 默认段 | **迁仓时丢掉的回归**：旧 kit 的 `init_book` 写过这三份文件与 `checks` 默认值，本仓的 `init` 一份都不写 |
| `apps/cli/src/commands/preflight.ts` | 从「只提示，不阻断」改为**未就绪即非 0 退出**；输出新增 `styleGate` 键（原字段保持不变） | 原先「规则空着」与「规则填好」在这条路上给同一个结果（退出码 0），作者看到「预检通过」就去写 |
| `apps/cli/src/commands/generate.ts` | 生成前 `assertStyleReady` | 挡在**烧 LLM 额度之前** |
| `apps/cli/src/commands/book.ts` | 批量开跑前 `assertStyleReady` | 批量代价最大（一次可能连写几十章），必须挡在第一次请求之前 |
| `apps/server/src/index.ts` | `/write` 与 `/generate` 前 `assertStyleReady` | 面板是「一章一章点」的入口，与 CLI 同属会产生新正文的动作；**少挡一处就是留了一条绕过路径** |
| `gates/consistency_check.py` | `--list-checks` 新增「本次**未生效**的机检项」一节 | 某项在 findings 里没出现，可能是「查了没问题」也可能是「根本没启用」，两者**同形**。只走 stderr、不产生 finding、不影响退出码 |
| `gates/consistency_check.py` | 清理死路径：`assets/rules/…` → `content/rules/…`；`assets/book.example.json` 目标档说明；`preflight.py` 批量判据说明 | 三处都在指向本仓不存在的东西；其中「批量长跑判据写死在 preflight.py」是**纯属虚构**——该判据在本仓没有实现 |
| `packages/core/test/converge-advisory.test.ts` | Python 探测由 `spawnSync` 改**异步** `spawn` | 见第 3 节：本机 `spawnSync` 一律 `EBUSY`，导致 8 项依赖 Python 的回归测试**在 Python 可用的机器上静默跳过** |
| `packages/core/test/style-gate.test.ts` | **新增** 6 项回归测试 | 把四条不变量固化，含「删掉文件仍不就绪」这条最容易退回去的 |

---

## 2. 实测证据

### 2.1 新书从「无守卫」到「被拦住」

```
$ node apps/cli/dist/index.js init --dir .probe-style --title 风格探针
{"ok":true,"styleDocsWritten":[".soloent\\rules\\story-style.md",
  ".soloent\\constitution\\MASTER.md","1-边界\\预期.md"]}

$ node apps/cli/dist/index.js preflight --book .probe-style --chapter 1
exit=1
⛔ 风格/红线层未就绪，已阻断开写：
  · .soloent/rules/story-style.md：本书风格规则（最高优先级）仍含占位符「✏️」
  · .soloent/constitution/MASTER.md：创作宪法仍含占位符「此处待填」
  · 1-边界/预期.md：开书预期（防跑偏锚点）与插件模板一字不差（等于没填）
```

三类判据**同时命中**——其中「与插件模板一字不差」这一条只有在 `TEMPLATES` 指向真实目录后才可能报出。

### 2.2 三个生成入口都被拦住（退出码均 1，且都不烧额度）

| 入口 | 结果 |
|---|---|
| `novel generate --book .probe-style --chapter 1` | exit 1，`StyleNotReadyError` |
| `novel book --book .probe-style --from 1 --to 1` | exit 1，同上 |
| `POST /generate`（服务端） | `{"error":"风格/红线层未就绪，已拒绝开始生成。…"}`，无挂起 |
| `POST /write`（服务端） | 同上 |

### 2.3 两条真书不被误拦（回归对照）

```
$ python gates/style_doc_check.py --root "D:/1-work/novel/高武-从全校倒数第一开始加点"
  ✅ 本书风格规则  ✅ 创作宪法  ✅ 开书预期      结论：可以开写。
$ node apps/cli/dist/index.js preflight --book <同书> --chapter 35   → exit=0
$ 仙侠-系统流-待定  → 同样 ready
```

### 2.4 封掉的绕过路径

| 绕过尝试 | 改前 | 改后 |
|---|---|---|
| 三份文件里写全角「（待填）」 | 词表不含，**放行** | ⛔ 拦住 |
| 删掉 `MASTER.md` | 只算 block → **放行** | ⛔ 拦住（`preflight` exit 1） |

### 2.5 突变验证（证明测试会咬人，不是摆设）

| 突变 | 期望红灯 | 实测 |
|---|---|---|
| `style_gate_ready` 退回「只算 block」 | 「一字不差」用例 | ✖ 命中 |
| `style_doc_issues` 把「缺失」降回 `warn` | 「删掉文件」用例 | ✖ 命中 |

> 注意这两条防线是**独立**的：只突变一处时另一处仍兜得住，所以「删掉文件」用例
> 额外钉住了「缺失必须映射到**严重**」——否则光看 `ready` 分不出是哪一道破了。

### 2.6 真书机检输出未变（回归对照）

真书《高武》34 章的机检结果不变；`--list-checks` 只在末尾**多了一节**（新书探针上）：

```
⚠ 本次**未生效**的机检项 4 项——下列各项不会产出任何发现，
  不要把它们没报问题当成「查过且没问题」：
  · 句长节奏：checks.rhythm.enabled = False
  · 章末钩子：checks.hook_check 未启用
  · 伏笔埋设：checks.foreshadow_check 未启用
  · 登记完整性：已启用但恒不生效：canon.md 人物表为空、登记册也为空（三方互校无输入）
```

---

## 3. 核验中翻出的三处「守卫在但不生效」

这三处都不是 `docs/21` 那份清单提到的，是照着「配置/守卫**存在**」继续追「**生效**吗」追出来的。

### 3.1 `TEMPLATES` 指向不存在的目录 → 模板比对是死分支

`PLUGIN_ROOT = <仓根>`，而 `templates/`、`assets/` 都不在仓根，它们在 `content/` 下。
`style_doc_issues` 的模板比对外面套着 `if os.path.isfile(tpl_path)`，
所以路径错了既不报错也不生效。**已修**（见第 1 节），并由 `style-gate.test.ts`
的「一字不差」用例钉住。

### 3.2 `hook_check` 在本仓恒不生效（未修，需决定）

`_hook_check` 靠 `import brief` 取细纲钩子，而 `brief.py` **未随迁**。
它的 `except Exception: return` 会把 `ImportError` 一并吞掉——
于是「启用了」与「生效了」是两回事，且**没有任何提示**。

处置：本轮只在 `--list-checks` 把它点名为「已启用但恒不生效」，**没有实现它**。
为什么不动：`brief.outline_block` 的职责（从卷纲抠出本章段）在迁仓后由
**TS 侧的 `readiness.ts`** 承担了。要在 Python 侧补回来，等于把同一套细纲解析
再实现一遍——正是本项目反复禁止的「同一判据两份副本」。
两条路都成立，但取向不同，需作者定：

- **A**：`_hook_check` 改读 `outline/ch-NN.md`（按章细纲），不再依赖卷纲解析——最小实现；
- **B**：把 `readiness.ts` 的卷纲回落逻辑导出给 Python 复用（需一个跨语言接口，重）。

### 3.3 `foreshadow_check` 对新书恒不生效（未修，同上）

`_foreshadow_check` 读 `book.json` 的 `paths.foreshadow`，而 `novel init` **不写这个键**、
也不产出伏笔表文件。所以新书即使把 `checks.foreshadow_check` 打开，也一条都不报。
本轮**没有**在 init 里补这个键——补一个指向不存在文件的路径，只会让
`--list-checks` 说「已启用」而实际恒不生效，比不写更坏。
与 3.2 一并交给作者定。

---

## 4. 本轮**刻意没做**的两件事（`docs/21` 已标为「需先问作者」）

| 项 | 现状 | 为什么不动 |
|---|---|---|
| **P1-2 `novel state --set`** | 保留 + stderr 告警 + 代码注释（`docs/20 §3.4` 的处置） | 作者标了「（保留）」，仓内零引用。清单的「直接删除」与这个待决状态冲突，属**作者一句话定**的事，不该由执行方自决 |
| **P1-3 kit 活内容里的 `tools/preflight.py`** | 原样（`docs/20 §3.3` 的处置） | 改文案等于替 kit 决定「以后走 kit 自带 preflight 还是改调 `novel gates`」——那是**架构取向**，不是修错 |

---

## 5. 与 `docs/21` 的分工

- `docs/21`：**核验**那份外部清单（8 项，3 项不成立、1 项根因判错、4 项成立），
  以及**修正后的**执行建议。
- `docs/22`（本文件）：**执行**其中第 1–3 步，并记录执行过程中新翻出的三处问题。

`docs/21` 第 4 节「不建议照做」的三条（P0-3 的零命中自陈、阈值 1500、在 TS 侧重写
`hasPlaceholder`）本轮同样**没有做**，理由不变。

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

/**
 * 随插件分发的模板根。
 *
 * 路径层级钉注：本文件编译产物位于 `apps/cli/dist/commands/`，上溯**四级** = 仓库根，
 * 模板在 `<仓根>/content/templates/`。改 tsconfig 的 outDir 或包目录深度必须同步此处。
 * 为什么把这句话写在这儿：`gates/kit.py` 的 TEMPLATES 就踩过同一个坑——
 * 它指向不存在的 `<仓根>/templates`，而模板比对外面套了 isfile 守卫，
 * 于是「与插件模板一字不差」这条判据**静默失效**（不报错、也不生效）。
 * 路径错了不会有任何提示，只有真的去用才会发现。
 */
const TEMPLATES_DIR = fileURLToPath(new URL('../../../../content/templates/', import.meta.url));

/**
 * 新书必须落地的三份「人写的规则」（键与顺序对齐 gates/kit.py 的 STYLE_DOCS）。
 *
 * 为什么必须落：这三份文件决定文风、红线与开书边界，是 `style_doc_check` 闸门的对象。
 * 旧版 init **一份都不写**——于是新书从第一章起就没有任何文风依据，
 * 而守卫只能报「缺失」。这是迁仓时丢掉的一步，属回归，不是新功能。
 *
 * 落地的刻意是**未填模板**（通篇占位符）：守卫会因此拦住开写，
 * 直到作者真的填过。写一份「看起来填好了」的空模板才是更坏的做法。
 */
const STYLE_DOCS: ReadonlyArray<{ tpl: string; rel: string; label: string }> = [
  { tpl: 'story-style.md', rel: path.join('.soloent', 'rules', 'story-style.md'), label: '本书风格规则' },
  { tpl: 'MASTER.md', rel: path.join('.soloent', 'constitution', 'MASTER.md'), label: '创作宪法' },
  { tpl: '预期.md', rel: path.join('1-边界', '预期.md'), label: '开书预期' },
];

/**
 * `checks` 默认段。
 *
 * ★这里只写**在 init 时刻能诚实地确定**的键。不写猜出来的阈值。
 *
 * 为什么不能只写 `{enabled: true}`：`consistency_check.py` 的阈值全部形如
 * `R.get("narr_avg_min", 0)`——缺阈值时兜底 0，而判据是 `avg < 0`，**永远不成立**。
 * 于是「开着」与「关着」在行为上完全一样，而 `--list-checks` 还会印出
 * `叙述句均长 ≥None`（这正是本项目已经修过一次的「清单说瞎话」）。
 * 阈值按规矩必须来自实测（story-style.md §3.1），新书没有样本，所以只能显式关闭并留下指令。
 */
function defaultChecks(): Record<string, unknown> {
  return {
    rhythm: {
      enabled: false,
      _tier: 'uncalibrated',
      _comment:
        '阈值必须来自实测，新书尚无样本，故先关。拆完样板书后跑：'
        + 'python gates/consistency_check.py --root <书目录> --suggest-rhythm --from 1-边界'
        + '，把输出的取值整组粘进来再把 enabled 改成 true。'
        + '⚠️ 只改 enabled、不粘阈值 = 该项照旧不产出任何发现（阈值兜底 0，判据永不成立）。',
      min_chars: 300,
      min_sentences: 12,
    },
    // panel 的存在即启用（没有 enabled 开关）；前缀与上限是通用值，不猜 forbid 词表。
    panel: { prefix: '【', max_lines: 12 },
    // 三方互校（canon 人物表／登记册／人物卡）。name_column 默认 0，
    // 本书人物表若是「项｜正典值」两列写法，须改成 1。
    name_roster: { enabled: true, name_column: 0 },
    // ⚠️ 刻意**不写** hook_check 与 foreshadow_check：
    //   · hook_check 依赖 `import brief`，而 brief.py 在本仓**不存在**，
    //     _hook_check 的 except 会把 ImportError 吞掉并 return —— 写了也不生效。
    //   · foreshadow_check 依赖 paths.foreshadow，而 init 不产出伏笔表文件。
    //   写一份「读不到、也不报错」的配置，就是本项目反复在治的「配置写了没人读」。
    //   两者均已列入 docs/22 的遗留。
  };
}

/**
 * novel init：开新书骨架。book.json 严格按 gates/kit.py config_problems 的校验项生成
 * （_schema / book.title / paths 四键 / chapter.file_regex / ledger.columns+chapter_column），
 * 另带 rules.author/plugin 空声明与 checks 默认段。
 * 目标目录已存在且非空 → 显式拒绝（不做静默覆盖）。
 */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('开新书：生成目录骨架 + 三份待填的风格/红线文件 + 可通过机检校验的 book.json')
    .requiredOption('--dir <dir>', '书目录绝对路径')
    .requiredOption('--title <title>', '书名')
    .option('--genre <genre>', '题材', '')
    .option('--platform <platform>', '平台', '')
    .action(async (opts: { dir: string; title: string; genre: string; platform: string }) => {
      const root = path.resolve(opts.dir);
      const existing = await readdir(root).catch(() => null);
      if (existing !== null && existing.length > 0) {
        throw new Error(`init：目标目录已存在且非空：${root}（不做静默覆盖，请换空目录或先清空）`);
      }

      await mkdir(path.join(root, 'chapters'), { recursive: true });
      await mkdir(path.join(root, 'outline'), { recursive: true });
      await mkdir(path.join(root, 'notes'), { recursive: true });
      await mkdir(path.join(root, 'state'), { recursive: true });
      await mkdir(path.join(root, '1-边界'), { recursive: true });
      await mkdir(path.join(root, '.soloent', 'rules'), { recursive: true });
      await mkdir(path.join(root, '.soloent', 'memory'), { recursive: true });
      await mkdir(path.join(root, '.soloent', 'constitution'), { recursive: true });

      const bookJson = {
        _schema: 1,
        _readme: '本书配置。rules.author/plugin 为生成侧规则启用清单（显式声明，不扫目录）。',
        book: {
          title: opts.title,
          slug: path.basename(root),
          genre: opts.genre,
          platform: opts.platform,
        },
        paths: {
          chapters: 'chapters',
          canon: '.soloent/canon.md',
          ledger: '.soloent/ledger.tsv',
          now: '.soloent/memory/now.md',
        },
        chapter: { file_regex: '^ch-(\\d+)\\.md$' },
        ledger: { columns: ['ch', 'day', 'note'], chapter_column: 'ch' },
        rules: { author: [], plugin: [] },
        checks: defaultChecks(),
      };
      await writeFile(
        path.join(root, '.soloent', 'book.json'),
        '\ufeff' + JSON.stringify(bookJson, null, 2) + '\n',
        'utf-8',
      );
      await writeFile(
        path.join(root, '.soloent', 'canon.md'),
        `# 正典速查表 · ${opts.title}\n\n> 写作前必读，关键值一律以此表为准，不凭印象。\n\n（待填）\n`,
        'utf-8',
      );
      await writeFile(path.join(root, '.soloent', 'memory', 'now.md'), '# 当前进度\n\n（待填）\n', 'utf-8');
      await writeFile(path.join(root, '.soloent', 'ledger.tsv'), 'ch\tday\tnote\n', 'utf-8');

      // 三份风格/红线文件：从插件模板复制**未填版本**。
      // 模板缺失 → 显式抛错（失败关闭），不做静默跳过：跳过的话新书会缺文件，
      // 而缺文件的后果要到作者真正开写时才以「没有文风依据」的形式暴露出来，离原因太远。
      const written: string[] = [];
      for (const doc of STYLE_DOCS) {
        const src = path.join(TEMPLATES_DIR, doc.tpl);
        let text: string;
        try {
          text = await readFile(src, 'utf-8');
        } catch {
          throw new Error(
            `init：插件模板缺失，无法生成「${doc.label}」：${src}\n`
              + `  模板根：${TEMPLATES_DIR}\n`
              + '  若插件安装不完整，请先补齐 content/templates/；'
              + '若改过 tsconfig 的 outDir 或包目录深度，请同步校正 init.ts 里的上溯层级。',
          );
        }
        await writeFile(path.join(root, doc.rel), text, 'utf-8');
        written.push(doc.rel);
      }

      process.stdout.write(
        JSON.stringify({ ok: true, bookRoot: root, styleDocsWritten: written }) + '\n',
      );
    });
}

import os
import re
import sys
import time
import json
import threading
import signal
from concurrent.futures import ThreadPoolExecutor, as_completed

# 尝试导入 tqdm 用于进度条
try:
    from tqdm import tqdm
except ImportError:
    tqdm = None

# ==========================================
# 👇 配置区域 (自动读取命令行参数和环境变量)
# ==========================================

def _load_dotenv(filepath):
    """从 .env 文件加载 KEY=VALUE 到环境变量（不覆盖已存在的）。"""
    if not os.path.isfile(filepath):
        return
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    if k and os.getenv(k) is None:
                        os.environ[k] = v
    except Exception:
        pass


def _derive_novel_paths(novel_path):
    """根据项目根目录推导输出路径（与 SKILL 约定一致）。"""
    novel_path = os.path.abspath(novel_path)
    novel_name = os.path.splitext(os.path.basename(novel_path))[0]
    project_root = os.getcwd()
    boundary_dir = os.path.join(project_root, "1-边界")
    cache_dir = os.path.join(project_root, "summary_cache")
    return {
        "project_root": project_root,
        "boundary_dir": boundary_dir,
        "cache_dir": cache_dir,
        "novel_name": novel_name,
        "chapter_list_md": os.path.join(cache_dir, f"1.0_{novel_name}_章节目录.md"),
        "synopsis_file": os.path.join(boundary_dir, f"1.1_{novel_name}_故事梗概.md"),
    }


def get_config():
    # 在解析命令行之前，尝试从 .env 加载（项目根目录或脚本所在目录的上一级）
    for dir_path in [os.getcwd(), os.path.dirname(os.path.dirname(os.path.abspath(__file__)))]:
        _load_dotenv(os.path.join(dir_path, ".env"))
        _load_dotenv(os.path.join(dir_path, ".soloent", ".api.env"))

    # 默认配置
    config = {
        "API_KEY": os.getenv("NOVEL_API_KEY", ""),
        "BASE_URL": os.getenv("NOVEL_API_BASE", "https://api.openai.com/v1"),
        "MODEL_NAME": os.getenv("NOVEL_API_MODEL", "gpt-4o"),
        "OUTPUT_LANGUAGE": "简体中文",
        "START_CHAPTER": 1,
        "TOTAL_CHAPTERS_LIMIT": 0,
        "CHAPTERS_PER_BATCH": int(os.getenv("NOVEL_CHAPTERS_PER_BATCH", "5") or "5"),
        "CHAPTERS_PER_BATCH_SMALL": int(os.getenv("NOVEL_CHAPTERS_PER_BATCH_SMALL", "2") or "2"),
        "BATCH_MAX_CHARS": int(os.getenv("NOVEL_BATCH_MAX_CHARS", "40000") or "40000"),
        "MAX_WORKERS": int(os.getenv("NOVEL_MAX_WORKERS", "2") or "2"),
        "RETRY_TIMES": 3,
        "API_TIMEOUT": float(os.getenv("NOVEL_API_TIMEOUT", "180") or "180"),
    }

    # 命令行参数处理
    config["LIST_CHAPTERS_ONLY"] = "--list-chapters" in sys.argv
    config["TOTAL_CHAPTERS_LIMIT"] = int(os.getenv("NOVEL_CHAPTERS_LIMIT", "0") or "0")

    argv_positional = []
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--list-chapters":
            pass
        elif arg == "--limit":
            if i + 1 >= len(argv):
                print("❌ 错误：--limit 需要指定章节数量，例如 --limit 100")
                sys.exit(1)
            config["TOTAL_CHAPTERS_LIMIT"] = int(argv[i + 1])
            i += 1
        elif arg.startswith("--"):
            print(f"❌ 错误：未知参数 {arg}")
            sys.exit(1)
        else:
            argv_positional.append(arg)
        i += 1

    if len(argv_positional) > 0:
        config["NOVEL_PATH"] = argv_positional[0]
    else:
        print("❌ 错误：请提供小说文件路径。")
        print("用法: python3 <技能包>/scripts/summarize.py <小说文件路径> [选项]")
        print("选项:")
        print("  --list-chapters       仅分章并导出章节目录，不调用 API")
        print("  --limit <N>           只处理前 N 章（也可用环境变量 NOVEL_CHAPTERS_LIMIT）")
        print("API Key 请通过 .env 文件或环境变量 NOVEL_API_KEY 提供，不要写在命令行。")
        sys.exit(1)

    if not config["API_KEY"] and not config["LIST_CHAPTERS_ONLY"]:
        env_path = os.path.join(os.getcwd(), ".env")
        if not os.path.isfile(env_path):
            default_env = """# 样板书梗概脚本 API 配置（仅限本地使用，请勿提交到仓库）
NOVEL_API_KEY=
NOVEL_API_BASE=https://api.openai.com/v1
NOVEL_API_MODEL=gpt-4o
"""
            try:
                with open(env_path, "w", encoding="utf-8") as f:
                    f.write(default_env)
                print("已创建 .env 文件：", os.path.abspath(env_path))
            except Exception as e:
                print("❌ 无法创建 .env 文件：", e)
                sys.exit(1)
        print("请在本地打开 .env 文件，填写 NOVEL_API_KEY 后重新运行本脚本。")
        print("（仅限本地使用，请勿将 .env 提交到仓库。）")
        sys.exit(1)

    # 自动推导输出路径（项目根/1-边界/ 与 项目根/summary_cache/）
    paths = _derive_novel_paths(config["NOVEL_PATH"])
    config["OUTPUT_FILE"] = paths["synopsis_file"]
    config["CACHE_DIR"] = paths["cache_dir"]
    
    return config

CONFIG = get_config()

# ==========================================
# 👆 配置结束，以下是核心逻辑
# ==========================================

client = None
CACHE_DIR = None
ERROR_LOG = None


def _log(msg):
    print(msg, flush=True)


def _append_error_log(batch_id, attempt, err):
    if not ERROR_LOG:
        return
    with open(ERROR_LOG, "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {batch_id} 尝试{attempt}: {err}\n")


def _format_api_error(err):
    msg = str(err)
    cause = getattr(err, "__cause__", None)
    if cause:
        msg = f"{msg} ({type(cause).__name__}: {cause})"
    if "Connection error" in msg:
        msg += " — 常见原因：API 网关返回空响应、网络中断、或请求体过大超时"
    return msg


def _batch_char_count(chapters):
    return sum(len(c.get("content", "")) for c in chapters)


def _build_batches(chapters, default_size, small_size, max_chars):
    """按字数动态分批：默认 default_size 章/批，超限则降为 small_size 章/批（不截断正文）。"""
    batches = []
    i = 0
    while i < len(chapters):
        window = chapters[i : i + default_size]
        size = default_size
        if window and _batch_char_count(window) > max_chars:
            size = small_size
        batch_chapters = chapters[i : i + size]
        batch_id = f"batch_{batch_chapters[0]['index']:04d}_{batch_chapters[-1]['index']:04d}"
        char_count = _batch_char_count(batch_chapters)
        batches.append({
            "id": batch_id,
            "chapters": batch_chapters,
            "char_count": char_count,
            "size": len(batch_chapters),
        })
        i += len(batch_chapters)
    return batches


def export_chapter_list(chapters, novel_path):
    """将分章结果导出为章节目录（Markdown）。"""
    paths = _derive_novel_paths(novel_path)
    novel_name = paths["novel_name"]
    os.makedirs(paths["cache_dir"], exist_ok=True)
    os.makedirs(paths["cache_dir"], exist_ok=True)

    md_lines = [
        f"# 《{novel_name}》章节目录",
        "",
        f"> 共 {len(chapters)} 章，由脚本自动识别分章",
        "",
        "| 序号 | 章节标题 | 正文字数 |",
        "| ---: | --- | ---: |",
    ]

    for c in chapters:
        title = c["title"]
        char_count = len(c.get("content", ""))
        safe_title = title.replace("|", "\\|")
        md_lines.append(f"| {c['index']} | {safe_title} | {char_count} |")

    with open(paths["chapter_list_md"], "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines) + "\n")

    print(f"📋 章节目录已导出: {os.path.abspath(paths['chapter_list_md'])}")
    return paths["chapter_list_md"]


def _init_api_client():
    """延迟初始化 OpenAI 客户端与缓存目录（仅梗概模式需要）。"""
    global client, CACHE_DIR, ERROR_LOG
    try:
        from openai import OpenAI
    except ImportError:
        print("❌ 错误：未安装 openai 库。")
        print("请在终端运行: pip install openai")
        sys.exit(1)

    client = OpenAI(
        api_key=CONFIG["API_KEY"],
        base_url=CONFIG["BASE_URL"],
        timeout=CONFIG["API_TIMEOUT"],
        max_retries=0,
    )
    CACHE_DIR = CONFIG["CACHE_DIR"]
    ERROR_LOG = os.path.join(CACHE_DIR, "_api_errors.log")
    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(CONFIG["OUTPUT_FILE"]), exist_ok=True)

    _log("🔌 正在测试 API 连通性...")
    try:
        resp = client.chat.completions.create(
            model=CONFIG["MODEL_NAME"],
            messages=[{"role": "user", "content": "回复 OK"}],
            max_tokens=10,
        )
        text = (resp.choices[0].message.content or "").strip()
        if not text:
            raise RuntimeError("API 返回了空内容")
        _log(f"✅ API 连通正常 (模型: {CONFIG['MODEL_NAME']})")
    except Exception as e:
        _log(f"❌ API 连通测试失败: {_format_api_error(e)}")
        _log(f"   端点: {CONFIG['BASE_URL']}")
        _log(f"   模型: {CONFIG['MODEL_NAME']}")
        _log("   请检查 .env 中的 NOVEL_API_KEY / NOVEL_API_BASE / NOVEL_API_MODEL 是否正确。")
        sys.exit(1)


class _ChapterTitleMatch:
    """行级章节命中，接口与 re.Match 的 group(1)/start() 一致。"""

    __slots__ = ("_start", "_title")

    def __init__(self, start, title):
        self._start = start
        self._title = title

    def start(self):
        return self._start

    def group(self, n):
        return self._title if n == 1 else None


# 英文小说正文里的兵力统计行（非章节标题）
_TROOP_ROSTER_TITLE = re.compile(
    r"^(?:"
    r"Slaves?\s*\("
    r"|Monkeys?\s+in\s+the"
    r"|Undead Warrior Trolls?\.?$"
    r"|(?:Crimson |Ice )?Wolves?,\s"
    r"|Wolves?\s+in\s+the"
    r"|Slimes?\.$"
    r"|Mythical Elemental Spirits?\.$"
    r"|Wyverns?\.$"
    r")",
    re.IGNORECASE,
)


def _is_english_chapter_title(title):
    """Royal Road 等英文章节标题行（不含行首序号）。"""
    if re.match(r"(?:Side|Bonus) Chapter[:;]", title, re.IGNORECASE):
        return True
    if re.match(r"\[.+\]", title):
        return True
    if not re.match(r"[A-Z]", title):
        return False
    if re.search(r"\(Around|\blost \d+|\d+ left\.", title, re.IGNORECASE):
        return False
    if _TROOP_ROSTER_TITLE.match(title):
        return False
    if re.search(r"\bwere lost\.", title, re.IGNORECASE):
        return False
    if re.match(r"\d+\.-", title):
        return False
    return True


def _find_english_chapter_title_matches(text):
    """英文章节：行首「序号 + 标题」，并按章节号单调递增去噪。"""
    line_start = 0
    candidates = []
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        m = re.match(r"^(\d+)\s+(.+)$", stripped)
        if m and _is_english_chapter_title(m.group(2)):
            candidates.append(
                (line_start + line.find(stripped), int(m.group(1)), stripped)
            )
        line_start += len(line)

    if not candidates:
        return []

    kept = []
    last_num = 0
    for start, num, title in candidates:
        if num > last_num:
            kept.append(_ChapterTitleMatch(start, title))
            last_num = num
    return kept


def _find_chapter_title_matches(text):
    """章节标题行定位；规则须与 extract_chapters.py 内同名函数保持一致。"""
    _indent = r"[ \t\u3000]*"
    md_only = re.compile(
        rf"(^{_indent}#+\s*第[ \d零一二三四五六七八九十百千万]+[章卷回节].*$)",
        re.MULTILINE,
    )
    md_hits = list(md_only.finditer(text))
    if len(md_hits) >= 2:
        return md_hits
    pattern = re.compile(
        rf"(^{_indent}(?:"
        r"#+\s*第[ \d零一二三四五六七八九十百千万]+[章卷回节]"
        r"|第[ \d零一二三四五六七八九十百千万]+[章卷回节]"
        r"|[\d]+[、．](?!\d)"
        r"|[\d]+\s+Chapter\s+[\d]+"
        r"|Chapter\s*[\d]+"
        r"|[\d]+\s+Chapter"
        r"|序章|尾声|番外|前言|后记"
        r").*$)",
        re.MULTILINE,
    )
    cn_hits = list(pattern.finditer(text))
    en_hits = _find_english_chapter_title_matches(text)
    if len(en_hits) >= 2 and len(en_hits) > len(cn_hits):
        return en_hits
    return cn_hits if cn_hits else en_hits


def extract_chapters(file_path):
    """读取并切分小说章节"""
    if not os.path.exists(file_path):
        print(f"❌ 错误：文件 {file_path} 不存在")
        return []

    with open(file_path, 'r', encoding='utf-8') as f:
        text = f.read()

    # -------------------------------------------------------
    # 🎯 智能章节识别逻辑（与 extract_chapters.py 内 _find_chapter_title_matches 保持一致）
    # -------------------------------------------------------
    matches = _find_chapter_title_matches(text)

    if not matches:
        print("⚠️ 警告：未能识别到任何章节标题！")
        print("可能原因：小说格式特殊，或者正则不匹配。")
        print("建议：检查小说文本，或者在脚本中修改 extract_chapters 的正则 pattern。")
        return []

    chapters = []
    for i, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.start()
        end = matches[i+1].start() if i+1 < len(matches) else len(text)
        
        # 提取内容（去除标题本身）
        content = text[start:end].replace(title, "", 1).strip()
        
        chapters.append({"index": i+1, "title": title, "content": content})
        
    print(f"✅ 成功识别 {len(chapters)} 个章节")
    
    # 打印前几个章节供检查
    print("👀 识别示例 (前5章):")
    for c in chapters[:5]:
        print(f"   - [{c['index']}] {c['title']}")
    print("   ...")

    export_chapter_list(chapters, file_path)
    
    return chapters

def is_traditional_chinese(text):
    """简单的繁体字检测 (启发式)"""
    # 常用繁体字样本
    traditional_chars = set("為麼這門見過對來應說後個國時種開車貝長樂風龍")
    count = sum(1 for char in text if char in traditional_chars)
    # 如果繁体字占比超过 1% (且总字数>100)，则认为是繁体
    return count > 0 and (count / len(text) > 0.005)

def review_and_fix_batches(batches, results, output_lang):
    """审查并修复有问题的批次"""
    bad_batches = []
    
    print("\n🔍 开始质量审查 (Review)...")
    
    for batch in batches:
        batch_id = batch["id"]
        if batch_id not in results:
            continue # 已经失败的不用管，主循环会处理
            
        content = results[batch_id]
        expected_count = len(batch["chapters"])
        
        # 1. 检查章节数量 (简单数 "##" 标题数量)
        # 宽松匹配，允许误差
        chapter_headers = content.count("## ")
        if chapter_headers < expected_count:
            print(f"❌ 批次 {batch_id} 完整性存疑: 预期 {expected_count} 章，实际识别到 {chapter_headers} 章。")
            bad_batches.append(batch)
            continue
            
        # 2. 检查语言 (仅当目标是简体中文时)
        if output_lang == "简体中文" and is_traditional_chinese(content):
             print(f"❌ 批次 {batch_id} 语言检测异常: 发现大量繁体字。")
             bad_batches.append(batch)
             continue
             
    return bad_batches

def generate_summary(batch_chapters, batch_id, is_retry=False):
    """调用 API 生成总结"""
    
    titles = [c['title'] for c in batch_chapters]
    content_text = "\n\n".join([c['content'] for c in batch_chapters])
    prompt_chars = len(content_text)
    
    # 如果是重试 (Review 不通过)，加强语气
    system_instruction = f"你是一个高效的小说摘要助手。请直接输出 Markdown 格式的章节梗概。注意：输出语言必须是 {CONFIG['OUTPUT_LANGUAGE']}。"
    if is_retry:
        system_instruction += " ⚠️ 上次生成的内容因语言或完整性问题未通过审查，请务必严格按照要求输出，特别是【繁简转换】和【章节完整性】。"
    
    prompt = f"""
你是一个专业的小说剧情分析师。请阅读以下 {len(batch_chapters)} 个章节的小说内容，并输出每个章节的【故事梗概】。

章节列表：
{', '.join(titles)}

【要求】
1. **请务必使用【{CONFIG['OUTPUT_LANGUAGE']}】来撰写所有的梗概内容**（即使原文是其他语言）。
2. 每个章节独立输出一段梗概，字数约50-100字。
3. 重点概括：核心事件、关键人物行动、剧情转折、伏笔。
4. 格式必须严格遵守以下 Markdown 格式，不要添加其他开场白：

## [完整章节标题]
[这里是梗概内容...]

---

以下是小说正文内容：
{content_text}
"""

    messages = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": prompt}
    ]

    # API 调用
    for attempt in range(CONFIG["RETRY_TIMES"]):
        try:
            response = client.chat.completions.create(
                model=CONFIG["MODEL_NAME"],
                messages=messages,
                temperature=0.7,
                max_tokens=4000  # 增加到 4000 以适应 20 章的输出量
            )
            content = response.choices[0].message.content
            if not content or not content.strip():
                raise RuntimeError("API 返回了空内容")
            return content
        except Exception as e:
            err = _format_api_error(e)
            _log(f"⚠️ 批次 {batch_id} (尝试 {attempt+1}/{CONFIG['RETRY_TIMES']}) 失败: {err} [prompt≈{prompt_chars}字]")
            _append_error_log(batch_id, attempt + 1, err)
            time.sleep(2 * (attempt + 1))
    
    return None


def generate_single_chapter_summary(chapter_dict, batch_id_suffix=""):
    """单章调用 API 生成梗概（用于单章审查修复）"""
    title = chapter_dict["title"]
    content = chapter_dict["content"]
    system_instruction = f"你是一个高效的小说摘要助手。请直接输出 Markdown 格式的一章梗概。输出语言必须是 {CONFIG['OUTPUT_LANGUAGE']}。"
    prompt = f"""
请阅读以下章节内容，输出该章节的【故事梗概】。

章节标题：{title}

【要求】
1. 使用【{CONFIG['OUTPUT_LANGUAGE']}】撰写，字数约 50-100 字。
2. 重点概括：核心事件、关键人物行动、剧情转折。
3. 格式严格按以下两行，不要其他开场白：

## {title}
[梗概内容...]
"""
    messages = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": prompt + "\n\n以下是正文：\n" + content}
    ]
    for attempt in range(CONFIG["RETRY_TIMES"]):
        try:
            response = client.chat.completions.create(
                model=CONFIG["MODEL_NAME"],
                messages=messages,
                temperature=0.5,
                max_tokens=500,
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"⚠️ 单章重试 ({title[:20]}... 尝试 {attempt+1}/{CONFIG['RETRY_TIMES']}) 失败: {e}")
            time.sleep(2 * (attempt + 1))
    return None


def _parse_batch_content_to_sections(content):
    """将批次输出按 ## 标题拆成 [(title, section_text), ...]"""
    sections = []
    pattern = re.compile(r'^##\s+(.+)$', re.MULTILINE)
    matches = list(pattern.finditer(content))
    for i, m in enumerate(matches):
        title = m.group(1).strip()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        section_text = content[m.end():end].strip()
        sections.append((title, section_text))
    return sections


def review_and_fix_single_chapters(batches, results, output_lang, min_section_len=15):
    """单章审查：检查每批内各章梗概长度，过短的单独重生成并替换"""
    fixed_any = False
    for batch in batches:
        batch_id = batch["id"]
        if batch_id not in results:
            continue
        content = results[batch_id]
        sections = _parse_batch_content_to_sections(content)
        expected = len(batch["chapters"])
        if len(sections) < expected:
            continue
        new_parts = []
        batch_fixed = False
        for i, (sec_title, sec_text) in enumerate(sections):
            if i >= expected:
                new_parts.append(f"## {sec_title}\n{sec_text}")
                continue
            is_bad = (not sec_text or len(sec_text.strip()) < min_section_len)
            if output_lang == "简体中文" and sec_text and is_traditional_chinese(sec_text):
                is_bad = True
            if not is_bad:
                new_parts.append(f"## {sec_title}\n{sec_text}")
                continue
            ch = batch["chapters"][i]
            print(f"   🔧 单章修复: {ch['title'][:30]}... (内容过短或语言异常)")
            single = generate_single_chapter_summary(ch, batch_id)
            if single:
                new_parts.append(single.strip())
                batch_fixed = True
                fixed_any = True
            else:
                new_parts.append(f"## {sec_title}\n{sec_text}")
        if batch_fixed:
            new_content = "\n\n".join(new_parts)
            results[batch_id] = new_content
            cache_path = os.path.join(CACHE_DIR, batch_id + ".md")
            with open(cache_path, "w", encoding="utf-8") as f:
                f.write(new_content)
    return fixed_any


def main():
    _init_api_client()
    print("🚀 开始执行全自动并行总结脚本...")
    print(f"📖 目标小说: {os.path.basename(CONFIG['NOVEL_PATH'])}")
    print(f"🧵 并行数量: {CONFIG['MAX_WORKERS']}")
    
    # 1. 读取章节
    all_chapters = extract_chapters(CONFIG["NOVEL_PATH"])
    if not all_chapters: return

    # 2. 过滤需要处理的章节
    start_idx = CONFIG["START_CHAPTER"] - 1
    if start_idx < 0: start_idx = 0
    target_chapters = all_chapters[start_idx:]
    
    # 限制总章节数
    limit = CONFIG["TOTAL_CHAPTERS_LIMIT"]
    if limit > 0:
        target_chapters = target_chapters[:limit]
    
    if not target_chapters:
        print("⚠️ 没有需要处理的章节。")
        return

    print(f"📌 计划处理: 第 {target_chapters[0]['index']} 章 - 第 {target_chapters[-1]['index']} 章 (共 {len(target_chapters)} 章)")

    # 3. 批次分组（按字数动态调整：默认 5 章/批，超限降为 2 章/批）
    default_size = CONFIG["CHAPTERS_PER_BATCH"]
    small_size = CONFIG["CHAPTERS_PER_BATCH_SMALL"]
    max_chars = CONFIG["BATCH_MAX_CHARS"]
    batches = _build_batches(target_chapters, default_size, small_size, max_chars)

    size_counts = {}
    for b in batches:
        size_counts[b["size"]] = size_counts.get(b["size"], 0) + 1
    size_summary = "，".join(f"{n}章×{c}批" for n, c in sorted(size_counts.items()))
    _log(f"📦 拆分为 {len(batches)} 个任务批次（{size_summary}，阈值 {max_chars} 字/批）...")

    # 4. 并发执行
    results = {}
    lock = threading.Lock()
    stop_event = threading.Event()

    # 优雅中断处理
    def signal_handler(sig, frame):
        print("\n\n⚠️ 检测到中断信号 (Ctrl+C)！")
        print("🛑 正在强制停止所有任务...")
        stop_event.set()
        # 强制退出，不再等待子线程
        os._exit(0)
        
    signal.signal(signal.SIGINT, signal_handler)
    
    # 先加载已有的缓存
    for batch in batches:
        cache_path = os.path.join(CACHE_DIR, batch["id"] + ".md")
        if os.path.exists(cache_path):
            with open(cache_path, 'r', encoding='utf-8') as f:
                results[batch["id"]] = f.read()
    
    pending_batches = [b for b in batches if b["id"] not in results]
    print(f"🔄 已跳过 {len(batches) - len(pending_batches)} 个已完成批次，剩余 {len(pending_batches)} 个待处理...")

    if not pending_batches:
        print("✅ 所有批次均已完成 (缓存命中)。")
    else:
        # 使用 tqdm 进度条 (如果有)
        pbar = tqdm(total=len(pending_batches), desc="AI 总结进度", unit="批") if tqdm else None
        
        with ThreadPoolExecutor(max_workers=CONFIG["MAX_WORKERS"]) as executor:
            futures = {}
            
            # 提交所有任务
            for batch in pending_batches:
                if stop_event.is_set(): break
                f = executor.submit(generate_summary, batch["chapters"], batch["id"])
                futures[f] = batch

            # 处理结果
            for future in as_completed(futures):
                batch = futures[future]
                try:
                    summary = future.result()
                    if summary:
                        # 写入缓存
                        cache_path = os.path.join(CACHE_DIR, batch["id"] + ".md")
                        with open(cache_path, 'w', encoding='utf-8') as f:
                            f.write(summary)
                        
                        with lock:
                            results[batch["id"]] = summary
                        
                        _log(f"💾 已写入缓存: {batch['id']}.md")
                        if pbar: pbar.update(1)
                        else: _log(f"✅ 完成批次 {batch['id']}")
                    else:
                        _log(f"\n❌ 批次 {batch['id']} 全部重试失败，未写入缓存")
                except Exception as exc:
                    print(f"\n❌ 批次 {batch['id']} 异常: {exc}")
                
                if stop_event.is_set():
                    break
                    
        if pbar: pbar.close()

    if stop_event.is_set():
        print("\n⚠️ 脚本已因用户中断而停止。")
        print(f"💾 已保存当前进度。下次运行脚本时，会自动从断点处继续。")
        sys.exit(0)

    # 5. 质量审查 (Review) & 自动修复：分批审查两轮 + 单章审查一轮
    def do_batch_review_and_fix(bad_list):
        for i, batch in enumerate(bad_list):
            print(f"   > 正在重修批次 {batch['id']} ({i+1}/{len(bad_list)})...")
            summary = generate_summary(batch["chapters"], batch["id"], is_retry=True)
            if summary:
                cache_path = os.path.join(CACHE_DIR, batch["id"] + ".md")
                with open(cache_path, 'w', encoding='utf-8') as f:
                    f.write(summary)
                results[batch["id"]] = summary

    # 5.1 分批审查第 1 轮
    bad_batches = review_and_fix_batches(batches, results, CONFIG["OUTPUT_LANGUAGE"])
    if bad_batches:
        print(f"🛠️ [分批审查 1/2] 发现 {len(bad_batches)} 个问题批次，正在修复...")
        do_batch_review_and_fix(bad_batches)

    # 5.2 分批审查第 2 轮
    bad_batches2 = review_and_fix_batches(batches, results, CONFIG["OUTPUT_LANGUAGE"])
    if bad_batches2:
        print(f"🛠️ [分批审查 2/2] 发现 {len(bad_batches2)} 个问题批次，正在修复...")
        do_batch_review_and_fix(bad_batches2)

    # 5.3 单章审查一轮
    print("\n🔍 开始单章审查...")
    if review_and_fix_single_chapters(batches, results, CONFIG["OUTPUT_LANGUAGE"]):
        print("   ✅ 部分章节已单章修复。")

    # 6. 合并结果
    done_count = sum(1 for b in batches if b["id"] in results)
    missing = [b["id"] for b in batches if b["id"] not in results]
    _log(f"\n📊 批次完成: {done_count}/{len(batches)}")
    if missing:
        _log(f"⚠️ 以下批次未成功，不会出现在最终梗概中: {', '.join(missing)}")
        if ERROR_LOG and os.path.isfile(ERROR_LOG):
            _log(f"   详细错误日志: {os.path.abspath(ERROR_LOG)}")
    if done_count == 0:
        _log("❌ 没有任何批次成功，未生成最终梗概文件。请先修复 API 后重新运行。")
        sys.exit(1)

    _log("\n💾 正在合并所有梗概...")
    final_content = f"# 《{os.path.basename(CONFIG['NOVEL_PATH'])}》 全书故事梗概\n\n> 本文档由 AI 自动并行生成\n\n"
    
    # 按顺序合并
    for batch in batches:
        if batch["id"] in results:
            final_content += results[batch["id"]] + "\n\n"
    
    with open(CONFIG["OUTPUT_FILE"], 'w', encoding='utf-8') as f:
        f.write(final_content)
        
    _log(f"🎉 全部完成！结果已保存至:\n{CONFIG['OUTPUT_FILE']}")


if __name__ == "__main__":
    if CONFIG.get("LIST_CHAPTERS_ONLY"):
        print("📑 仅导出章节目录模式（不调用 API）...")
        chapters = extract_chapters(CONFIG["NOVEL_PATH"])
        if not chapters:
            sys.exit(1)
        sys.exit(0)
    main()

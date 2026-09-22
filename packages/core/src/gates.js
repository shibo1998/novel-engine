import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SEVERITIES = new Set(['严重', '中等', '轻微', '提示']);
function collect(child) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}
function firstLine(text) {
    const [line = ''] = text.split('\n', 1);
    return line.trim();
}
function shapeError(field, raw) {
    return new Error(`gate 输出 shape 不符：字段 ${field}；stdout 前 200 字符：${raw.slice(0, 200)}`);
}
function assertGateResult(value, raw) {
    if (typeof value !== 'object' || value === null)
        throw shapeError('(root)', raw);
    const v = value;
    if (typeof v['gate'] !== 'string')
        throw shapeError('gate', raw);
    if (typeof v['book_root'] !== 'string')
        throw shapeError('book_root', raw);
    if (typeof v['chapter_count'] !== 'number')
        throw shapeError('chapter_count', raw);
    if (typeof v['counts'] !== 'object' || v['counts'] === null)
        throw shapeError('counts', raw);
    for (const [k, val] of Object.entries(v['counts'])) {
        if (typeof val !== 'number')
            throw shapeError(`counts.${k}`, raw);
    }
    if (!Array.isArray(v['findings']))
        throw shapeError('findings', raw);
    for (const f of v['findings']) {
        if (typeof f !== 'object' || f === null)
            throw shapeError('findings[]', raw);
        const r = f;
        if (typeof r['severity'] !== 'string' || !SEVERITIES.has(r['severity']))
            throw shapeError('findings[].severity', raw);
        if (typeof r['chapter'] !== 'string')
            throw shapeError('findings[].chapter', raw);
        if (typeof r['line'] !== 'number')
            throw shapeError('findings[].line', raw);
        if (typeof r['check'] !== 'string')
            throw shapeError('findings[].check', raw);
        if (typeof r['detail'] !== 'string')
            throw shapeError('findings[].detail', raw);
    }
    return v;
}
export async function runGates(opts) {
    // Windows 可执行名是 python / py -3，不是 python3；NOVEL_PYTHON 可覆盖
    const py = opts.python ?? process.env['NOVEL_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');
    const gate = opts.gate ?? 'consistency_check';
    // 路径层级钉注：本文件编译产物位于 packages/core/dist/，new URL 上溯三级 = 仓库根。
    // 若修改 tsconfig 的 outDir 或包目录深度，必须同步此处，否则会静默指到错误位置。
    const gatePath = fileURLToPath(new URL(`../../../gates/${gate}.py`, import.meta.url));
    // 检查器书根只认 --root 开关；位置参数会被当成章节白名单（实测：exit 2）
    const child = spawn(py, [gatePath, '--root', opts.bookRoot], {
        // 不加 PYTHONIOENCODING=utf-8，findings 里的中文在 Windows 上会变 gbk 乱码
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
    });
    let collected;
    try {
        collected = await collect(child);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`gate 子进程启动失败（${py}）：${message}`);
    }
    const { code, stdout, stderr } = collected;
    // 语义钉注：检查器「发现问题也返回 0」，非 0（exit 2）才是执行失败
    if (code !== 0) {
        throw new Error(`gate 执行失败（exit ${code ?? 'signal'}）：${firstLine(stderr)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        throw new Error(`gate 输出不是合法 JSON；stdout 前 200 字符：${stdout.slice(0, 200)}`);
    }
    return assertGateResult(parsed, stdout);
}
//# sourceMappingURL=gates.js.map
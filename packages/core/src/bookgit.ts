import { spawn } from 'node:child_process';
import path from 'node:path';
import { cfgSection, readBookConfig } from './bookcfg.js';

/**
 * 书目录的 git 提交（B-51 / v0.2 X5）。
 *
 * 为什么需要：书目录本身是 git 仓库（v0.2 §3.1 的建议），而**每章一次提交**
 * 是这套系统里唯一的「可回退点」——B-24 的 checkpoint 是进程内的，
 * 真正能救回「昨天那版第 20 章」的只有 git。
 * 让人每次手动 `git add -A && git commit` 一定会漏，而漏了之后
 * 那个可回退点就没了。
 *
 * ★四条纪律：
 *   1. **不是 git 仓库 → 明确报「跳过」并说原因**，不静默成功。
 *      「提交了」与「没提交」必须形状不同（本项目最忌的那类同形）。
 *   2. **没有改动 → 不是错误**，报「无可提交」并返回 `committed: false`。
 *   3. **默认不自动提交**：git 历史是作者的东西，工具不替他决定要不要留痕。
 *      要开就 `book.json` 里写 `"git": { "autoCommit": true }`。
 *   4. **提交信息含章号**（X5 明文）：翻 git log 时要能一眼对上是哪一章。
 */

export interface CommitResult {
  /** 是否真的产生了一个新提交 */
  committed: boolean;
  /** 没提交时说明为什么（**不许静默**） */
  skippedReason?: string;
  /** 提交后的短 hash（committed 时才有） */
  hash?: string;
  message: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    c.stdout.setEncoding('utf-8');
    c.stderr.setEncoding('utf-8');
    c.stdout.on('data', (d: string) => { out += d; });
    c.stderr.on('data', (d: string) => { err += d; });
    c.on('error', (e) => resolve({ code: null, out, err: e.message }));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 书目录是不是 git 仓库（`rev-parse --git-dir` 成功即可，不管是不是仓库根） */
export async function isGitRepo(bookRoot: string): Promise<boolean> {
  const r = await run('git', ['rev-parse', '--git-dir'], path.resolve(bookRoot));
  return r.code === 0;
}

/** `book.json` 的 `git.autoCommit`（缺省 false——git 历史是作者的东西，不替他决定） */
export async function autoCommitEnabled(bookRoot: string): Promise<boolean> {
  const c = await readBookConfig(bookRoot);
  if (c === null) return false;
  return cfgSection(c.cfg, 'git')['autoCommit'] === true;
}

export interface CommitBookOptions {
  bookRoot: string;
  /** 提交信息。缺省用通用文案——**不要编章号**，没有就说没有 */
  message?: string;
  chapterNo?: number;
  /** 章节标题（有则进提交信息，方便 git log 扫读） */
  title?: string;
}

/**
 * 提交书目录的全部改动。**不 push**——推送是对外动作，工具不做。
 */
export async function commitBook(o: CommitBookOptions): Promise<CommitResult> {
  const root = path.resolve(o.bookRoot);
  const head = o.chapterNo !== undefined
    ? `第 ${o.chapterNo} 章${o.title !== undefined && o.title !== '' ? ` ${o.title}` : ''}`
    : '书目录更新';
  const message = o.message ?? head;

  if (!(await isGitRepo(root))) {
    return {
      committed: false,
      skippedReason: `${root} 不是 git 仓库——无法提交。若想让每章有一个可回退点：git init && git add -A && git commit -m "初始"`,
      message,
    };
  }

  // 先看有没有改动：没有就**不提交**，也不报错（干净树不是问题）
  const status = await run('git', ['status', '--porcelain'], root);
  if (status.code !== 0) {
    return { committed: false, skippedReason: `git status 失败：${status.err.trim() || status.out.trim()}`, message };
  }
  if (status.out.trim() === '') {
    return { committed: false, skippedReason: '工作区干净，没有可提交的改动', message };
  }

  const add = await run('git', ['add', '-A'], root);
  if (add.code !== 0) {
    return { committed: false, skippedReason: `git add 失败：${add.err.trim()}`, message };
  }
  const commit = await run('git', ['commit', '-m', message], root);
  if (commit.code !== 0) {
    return { committed: false, skippedReason: `git commit 失败：${commit.err.trim() || commit.out.trim()}`, message };
  }
  const hash = await run('git', ['rev-parse', '--short', 'HEAD'], root);
  return { committed: true, hash: hash.out.trim(), message };
}

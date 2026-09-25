import { createHash } from 'node:crypto';

/**
 * 内容指纹（全项目**唯一**一处实现）。
 *
 * 归一：剥首行 BOM + CRLF → LF。这两步是必须的——
 * 同一份正文在 Windows 检出（CRLF）与 git 里（LF）字节不同，
 * 不归一的话「内容没变」会被判成「变了」，闸门结论会无端作废。
 *
 * 为什么要有这个模块：`plan.ts` 的层级签字、`state.ts` 的 gateStatus、
 * `judges.ts` 的判据结论，三处都要「内容变没变」这个判断。
 * 三处各写一份 → 迟早漂移（本项目已为此吃过多次亏）。所以只留这一份。
 */
export function contentHash(text: string): string {
  const norm = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16);
}

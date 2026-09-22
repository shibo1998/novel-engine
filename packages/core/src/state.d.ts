import type { GateResult, GateStatus, StoryState } from './types.js';
export interface ReadStateOptions {
    bookRoot: string;
    /** 强制走重建分支（CLI --rebuild 的入口）；契约两条分支不变，此开关只是绕过缓存 */
    force?: boolean;
}
/**
 * 读状态。行为：
 *  1. <bookRoot>/state/story.json 存在且 schemaVersion 匹配且与书配对 → 解析返回
 *  2. 不存在 / 版本不符 / 与书不配对 / JSON 损坏 → 扫 chapters/ 重建（内存返回，不写盘）
 *  3. bookRoot 不是目录 → throw
 *  返回前一律经过过期清扫（重建分支产出全 null，清扫为空操作）。
 */
export declare function readState(opts: ReadStateOptions): Promise<StoryState>;
/**
 * 写状态。原子写：写 story.json.tmp → rename。
 * 写前归一：chapters 按 chapterNo 升序，generatedAt 刷新。
 */
export declare function writeState(state: StoryState): Promise<void>;
/**
 * 把 runGates 结果按文件名聚合成每章摘要。key 即 ChapterIndexEntry.file。
 * 注意：map 只含**有 finding 的章**；无 finding 的章由编排层按需补 { worst: "clean", count: 0 }。
 */
export declare function summarizeGateResult(result: GateResult): Map<string, GateStatus>;

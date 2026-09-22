import type { GateResult } from './types.js';
export interface RunGatesOptions {
    bookRoot: string;
    gate?: string;
    python?: string;
}
export declare function runGates(opts: RunGatesOptions): Promise<GateResult>;

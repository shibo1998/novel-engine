import type { GateResult } from './types.js';

export interface RunGatesOptions {
  gates?: string[];
  cwd?: string;
}

export async function runGates(targetPath: string, options?: RunGatesOptions): Promise<GateResult[]> {
  throw new Error('runGates 尚未实现：当前仅建立对外契约');
}

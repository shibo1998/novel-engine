export * from './types.js';
export { buildPrompt, loadRules, auditRules, RuleFileMissing } from './prompt.js';
export type { RuleAudit } from './prompt.js';
export { callLLM, isRetryable, llmBreakerState, resetLlmBreaker } from './llm.js';
export type { CallLLMOptions } from './llm.js';
export { runGates, GateFailureError, parseGateError, assertNoResultOnFailure } from './gates.js';
export type { RunGatesOptions } from './gates.js';
export { runStyleGate, assertStyleReady, StyleNotReadyError, STYLE_GATE } from './style.js';
export type { StyleGateReport, RunStyleGateOptions } from './style.js';
export { readState, writeState, summarizeGateResult, applyGateResult, snapshotChapterHashes, stripConclusions, isPassingWorst, BLOCKING_SEVERITIES, SCHEMA_VERSION } from './state.js';
export { contentHash } from './hash.js';
export {
  acquireBookLock,
  releaseBookLock,
  forceReleaseBookLock,
  readBookLock,
  withBookLock,
  BookLockedError,
} from './lock.js';
export type { BookLockInfo, BookLockHandle, AcquireOptions } from './lock.js';
export {
  readBookConfig,
  writeBookConfig,
  bookConfigPath,
  cfgString,
  cfgStringArray,
  cfgSection,
  DEFAULT_NOW_PATH,
} from './bookcfg.js';
export type { BookConfig } from './bookcfg.js';
export type { ReadStateOptions, ApplyGateResultOptions } from './state.js';
export { writeChapter, saveChapterText, convergeChapter } from './generate.js';
export type { WriteChapterOptions, WriteChapterResult, ConvergeOptions, ConvergeResult, ConvergeRound } from './generate.js';
export { reviseByQuote, applyPatches, locateQuote, readReviseConfig } from './revise.js';
export type { QuotePatch, SkippedPatch, ReviseByQuoteResult, ReviseByQuoteOptions, ReviseConfig } from './revise.js';
export { readSummaries, assembleLongContext, updateChapterSummary, proposeStateCard, CONTEXT_CHAR_CAP } from './summaries.js';
export type { ChapterSummary, SummaryStore, LongContext } from './summaries.js';
export { checkChapterReadiness, extractChapterSection, enclosingStageHeading, declaredOutlinePath, OUTLINE_CHAR_CAP } from './readiness.js';
export type { ChapterReadiness, OutlineScope } from './readiness.js';
export { recordFeedback, loadFeedback, diffLines } from './feedback.js';
export type { DiffHunk } from './feedback.js';
export { collectStats, editedLineCount } from './stats.js';
export type { BookStats, ChapterStats } from './stats.js';
export { listRuleCandidates, adoptRuleCandidate, RuleAdoptError, CANDIDATE_DIR_REL } from './rules.js';
export type { RuleCandidate, AdoptOptions, AdoptResult } from './rules.js';
export type { FeedbackInput } from './feedback.js';
export {
  checkHookAnchor,
  parseHookSpecs,
  readHookSpecs,
  auditHooks,
  DEFAULT_HOOK_TAIL_CHARS,
} from './hooks.js';
export type { HookSpec, HookCheckResult, HookAuditEntry } from './hooks.js';
export {
  POSITION_QUESTIONS,
  LAYER_ORDER,
  LAYER_LABEL,
  layerFile,
  layerKey,
  readPlan,
  initPlan,
  writePosition,
  planStatus,
  confirmLayer,
  checkPlanGate,
  assertPlanReady,
  PlanNotReadyError,
  draftLayer,
  hashText,
  PlanLayerError,
} from './plan.js';
export type { LayerKind, LayerStatus, LayerReport, LayerConfirm, PlanFile, PlanVolume, PlanGateReport } from './plan.js';
export {
  DEFAULT_JUDGE_DEFS,
  JudgeDefMissing,
  JudgesNotDeclared,
  judgeFile,
  readJudgeDecl,
  loadJudges,
  scaffoldJudges,
  evidenceFound,
  evaluateCriteria,
  parseJudgeOutput,
  judgeChapter,
  writeJudgeStatus,
  readJudgeStatus,
} from './judges.js';
export type {
  JudgeVerdict,
  JudgeEvidence,
  JudgeCriterionResult,
  JudgeDef,
  LoadedJudge,
  JudgeResult,
  JudgeChapterOptions,
  JudgeChapterStatus,
  JudgeStore,
  ParsedJudgeItem,
  EvaluateInput,
  EvaluateOutput,
} from './judges.js';

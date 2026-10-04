import type { PreflightReport, AuthStatus } from './preflight-types.js';

/**
 * The IPC contract between main and renderer.
 *
 * Channel names live here as constants so main and preload cannot drift apart,
 * and the renderer only ever sees the named functions the preload exposes —
 * never ipcRenderer itself.
 */

export const CHANNELS = {
  preflightRun: 'preflight:run',
  signInStart: 'signin:start',
  signInCancel: 'signin:cancel',
  signInProgress: 'signin:progress',
  openExternal: 'shell:openExternal',
  appInfo: 'app:info',
  pickLecture: 'lecture:pick',
  importLecture: 'lecture:import',
  listLectures: 'lecture:list',
  generate: 'generate:run',
  generateProgress: 'generate:progress',
  generateCancel: 'generate:cancel',
  listTriage: 'triage:list',
  setItemStatus: 'triage:setStatus',
  verifyItem: 'triage:verify',
  studyQueue: 'study:queue',
  studyStats: 'study:stats',
  answerCard: 'study:answer',
} as const;

export type SignInProgress =
  | {
      phase: 'launched';
      launched: boolean;
      /** Shown so the user can run it by hand if no terminal opened. */
      manualCommand: string;
      reason?: string;
    }
  | { phase: 'waiting'; attempt: number };

export type SignInOutcome =
  | { ok: true; auth: AuthStatus }
  | {
      ok: false;
      reason: 'timeout' | 'cancelled' | 'no_cli';
      message: string;
    };

export interface AppInfo {
  version: string;
  platform: string;
  dataDir: string;
}

/** The surface exposed on window.nursedeck by the preload. */
export interface NurseDeckBridge {
  preflight(): Promise<PreflightReport>;
  signIn(): Promise<SignInOutcome>;
  cancelSignIn(): Promise<void>;
  onSignInProgress(cb: (p: SignInProgress) => void): () => void;
  openExternal(url: string): Promise<void>;
  appInfo(): Promise<AppInfo>;
  pickLecture(): Promise<string[]>;
  importLecture(filePath: string): Promise<ImportResult>;
  listLectures(): Promise<LectureSummary[]>;
  generate(lectureId: string, kinds: GenKind[]): Promise<GenSummary>;
  cancelGeneration(): Promise<void>;
  onGenerateProgress(cb: (p: GenProgress) => void): () => void;
  listTriage(lectureId: string): Promise<TriageItem[]>;
  setItemStatus(itemId: string, status: 'accepted' | 'rejected'): Promise<void>;
  verifyItem(itemId: string): Promise<TriageCitation[]>;
  studyQueue(lectureId?: string): Promise<StudyCard[]>;
  studyStats(lectureId?: string): Promise<StudyStats>;
  answerCard(payload: AnswerPayload): Promise<void>;
}

export type { PreflightReport, AuthStatus };

/* ----------------------- lecture import & generation ---------------------- */

export interface LectureSummary {
  id: string;
  title: string;
  importedAt: string;
  itemCount: number;
  pendingCount: number;
  studiableCount: number;
}

export interface ImportResult {
  lectureId: string;
  title: string;
  blockCount: number;
  warnings: string[];
}

export type GenKind = 'flashcard' | 'cloze' | 'qa' | 'nclex';

export interface GenProgress {
  kind: GenKind;
  batch: number;
  totalBatches: number;
  produced: number;
  rejected: number;
  phase: 'generating' | 'validating' | 'verifying' | 'done';
}

export interface GenSummary {
  accepted: number;
  rejected: { kind: string; front: string; reason: string; stage: string }[];
  estimatedCostUsd: number;
  errors: string[];
}

export interface TriageCitation {
  id: string;
  excerpt: string;
  sourceTitle: string;
  licenseTier: string;
  verdict: 'unverified' | 'verified' | 'failed';
  failureStage?: string;
  failureDetail?: string;
}

export interface TriageItem {
  id: string;
  kind: GenKind;
  front: string;
  back: string;
  payload: unknown;
  clientNeed?: string;
  citations: TriageCitation[];
  /** Slides this came from, for the "see the source" link. */
  blocks: { ordinal: number; heading?: string }[];
}

/* -------------------------------- studying -------------------------------- */

export interface StudyCard {
  id: string;
  kind: GenKind;
  /** What is shown before the answer; for cloze the blank is masked. */
  prompt: string;
  expectedAnswer: string;
  isNew: boolean;
  blocks: { ordinal: number; heading?: string }[];
  citation?: { excerpt: string; sourceTitle: string };
  /** Predicted next due date per button, as ISO strings. */
  preview: { again: string; hard: string; good: string; easy: string };
}

export interface StudyStats {
  total: number;
  dueNow: number;
  unseen: number;
  averageRetrievability: number;
  calibrationGap?: number;
  illusionOfKnowing: number;
}

export interface AnswerPayload {
  itemId: string;
  rating: number;
  confidence?: number;
  correct?: boolean;
  durationMs?: number;
  mode?: 'review' | 'type' | 'cloze' | 'exam' | 'match';
}

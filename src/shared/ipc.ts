import type { PreflightReport, AuthStatus } from './preflight-types.js';

/**
 * The IPC contract between main and renderer.
 *
 * Channel names live here as constants so main and preload cannot drift apart,
 * and the renderer only ever sees the named functions the preload exposes --
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
  examStart: 'exam:start',
  examSubmit: 'exam:submit',
  dashboard: 'stats:dashboard',
  corroborate: 'sources:corroborate',
  exportDeck: 'deck:export',
  listDeck: 'deck:list',
  addCard: 'deck:add',
  editCard: 'deck:edit',
  deleteCard: 'deck:delete',
  importDeck: 'deck:import',
  vouchCard: 'deck:vouch',
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
  startExam(lectureId: string | undefined, length: number): Promise<StartedExam>;
  submitExam(examId: string, answers: ExamAnswer[]): Promise<ExamResult>;
  dashboard(lectureId?: string, examDate?: string): Promise<Dashboard>;
  corroborate(itemId: string): Promise<CorroborationReport>;
  exportDeck(
    lectureId: string | undefined,
    format: 'anki-tsv' | 'quizlet-csv' | 'apkg',
  ): Promise<{ saved: boolean; path?: string; cardCount: number; skipped: number }>;
  /** Imports a deck somebody else made. Cards land unverified and unstudiable. */
  importDeck(lectureId: string): Promise<ImportDeckSummary>;
  /** Records that she stands behind an imported card, making it studiable. */
  vouchCard(itemId: string): Promise<void>;
  listDeck(lectureId?: string): Promise<DeckCardRow[]>;
  addCard(card: NewUserCard): Promise<string>;
  editCard(edit: CardEdit): Promise<{ requiresReverification: boolean }>;
  deleteCard(itemId: string): Promise<void>;
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

/* --------------------------------- exams ---------------------------------- */

export interface ExamOption {
  id: string;
  text: string;
}

export interface ExamQuestion {
  itemId: string;
  position: number;
  stem: string;
  itemType: 'multiple_choice' | 'select_all' | 'select_n';
  selectN?: number;
  options: ExamOption[];
  clientNeed?: string;
}

export interface ExamBlueprintRow {
  clientNeed: string;
  target: number;
  actual: number;
  inBand: boolean;
}

export interface StartedExam {
  examId: string;
  title: string;
  questions: ExamQuestion[];
  blueprint: ExamBlueprintRow[];
  shortfalls: string[];
  estimatedMinutes: number;
}

export interface ExamAnswer {
  itemId: string;
  selected: string[];
  durationMs?: number;
}

export interface ExamSubscore {
  label: string;
  earned: number;
  possible: number;
  percent: number;
  n: number;
  reliable: boolean;
}

export interface ExamResult {
  pointsEarned: number;
  pointsPossible: number;
  percent: number;
  byClientNeed: ExamSubscore[];
  byNjcmmStep: ExamSubscore[];
  byCognitiveLevel: ExamSubscore[];
  byItemType: ExamSubscore[];
  overSelectionRate?: number;
  estimatedMinutes: number;
  actualMinutes: number;
  /** Per-question review, with the scoring arithmetic made explicit. */
  review: {
    itemId: string;
    stem: string;
    earned: number;
    possible: number;
    options: {
      id: string; text: string; isKey: boolean; chosen: boolean;
      rationale: string; errorClass?: string;
    }[];
    citation?: { excerpt: string; sourceTitle: string };
  }[];
}

/* ------------------------------- dashboard -------------------------------- */

export interface TopicReadinessRow {
  topic: string;
  readiness: number;
  low: number;
  high: number;
  cardCount: number;
  reviewCount: number;
  predictedRecall: number;
  reliable: boolean;
}

export interface ForecastPoint {
  date: string;
  due: number;
}

export interface ExamProjectionRow {
  topic: string;
  readinessNow: number;
  projectedRecall: number;
  cardCount: number;
  unseenBefore: number;
  atRisk: boolean;
}

export interface WeakCard {
  itemId: string;
  front: string;
  lapses?: number;
  occurrences?: number;
  meanConfidence?: number;
}

export interface Dashboard {
  stats: StudyStats;
  topics: TopicReadinessRow[];
  forecast: ForecastPoint[];
  leeches: WeakCard[];
  illusions: WeakCard[];
  projection?: ExamProjectionRow[];
}

/* ----------------------------- corroboration ------------------------------ */

export interface CorroborationReport {
  itemId: string;
  outcome: 'confirmed' | 'conflict' | 'not_found' | 'inconclusive';
  sourceTitle?: string;
  sourceUrl?: string;
  excerpt?: string;
  detail?: string;
}

/* --------------------------- her own cards -------------------------------- */

export interface DeckCardRow {
  id: string;
  kind: GenKind;
  front: string;
  back: string;
  status: 'pending' | 'accepted' | 'rejected' | 'quarantined';
  authoredBy: 'generated' | 'user' | 'imported';
  /** File an imported card came from, so its provenance stays visible. */
  importedFrom?: string;
  edited: boolean;
  verified: boolean;
  lectureTitle: string;
}

export interface ImportDeckSummary {
  /** False when she cancelled the file dialog. */
  chosen: boolean;
  filename?: string;
  imported: number;
  duplicates: number;
  /** Lines that were not readable as cards. */
  unreadable: number;
}

export interface NewUserCard {
  lectureId: string;
  kind: 'flashcard' | 'cloze' | 'qa';
  front: string;
  back: string;
  clientNeed?: string;
}

export interface CardEdit {
  itemId: string;
  front?: string;
  back?: string;
  clientNeed?: string;
}

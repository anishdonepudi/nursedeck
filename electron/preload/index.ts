import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNELS,
  type NurseDeckBridge,
  type SignInProgress,
  type GenProgress,
  type GenKind,
  type AnswerPayload,
  type ExamAnswer,
  type NewUserCard,
  type CardEdit,
} from '@shared/ipc.js';

/**
 * The only bridge between the renderer and the main process.
 *
 * Exposes named functions rather than ipcRenderer itself, so the renderer can
 * never invoke an arbitrary channel. Each function is a thin, typed wrapper.
 */

const bridge: NurseDeckBridge = {
  preflight: () => ipcRenderer.invoke(CHANNELS.preflightRun),
  signIn: () => ipcRenderer.invoke(CHANNELS.signInStart),
  cancelSignIn: () => ipcRenderer.invoke(CHANNELS.signInCancel),

  onSignInProgress: (cb: (p: SignInProgress) => void) => {
    const listener = (_e: unknown, payload: SignInProgress) => cb(payload);
    ipcRenderer.on(CHANNELS.signInProgress, listener);
    // Returns an unsubscribe so a React effect can clean up and we never leak
    // listeners across re-renders.
    return () => ipcRenderer.removeListener(CHANNELS.signInProgress, listener);
  },

  openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.openExternal, url),

  pickLecture: () => ipcRenderer.invoke(CHANNELS.pickLecture),
  importLecture: (filePath: string) => ipcRenderer.invoke(CHANNELS.importLecture, filePath),
  listLectures: () => ipcRenderer.invoke(CHANNELS.listLectures),
  generate: (lectureId: string, kinds: GenKind[]) =>
    ipcRenderer.invoke(CHANNELS.generate, lectureId, kinds),
  cancelGeneration: () => ipcRenderer.invoke(CHANNELS.generateCancel),

  onGenerateProgress: (cb: (p: GenProgress) => void) => {
    const listener = (_e: unknown, payload: GenProgress) => cb(payload);
    ipcRenderer.on(CHANNELS.generateProgress, listener);
    return () => ipcRenderer.removeListener(CHANNELS.generateProgress, listener);
  },

  listTriage: (lectureId: string) => ipcRenderer.invoke(CHANNELS.listTriage, lectureId),
  setItemStatus: (itemId: string, status: 'accepted' | 'rejected') =>
    ipcRenderer.invoke(CHANNELS.setItemStatus, itemId, status),
  verifyItem: (itemId: string) => ipcRenderer.invoke(CHANNELS.verifyItem, itemId),

  studyQueue: (lectureId?: string) => ipcRenderer.invoke(CHANNELS.studyQueue, lectureId),
  studyStats: (lectureId?: string) => ipcRenderer.invoke(CHANNELS.studyStats, lectureId),
  answerCard: (payload: AnswerPayload) => ipcRenderer.invoke(CHANNELS.answerCard, payload),

  startExam: (lectureId: string | undefined, length: number) =>
    ipcRenderer.invoke(CHANNELS.examStart, lectureId, length),
  submitExam: (examId: string, answers: ExamAnswer[]) =>
    ipcRenderer.invoke(CHANNELS.examSubmit, examId, answers),

  dashboard: (lectureId?: string, examDate?: string) =>
    ipcRenderer.invoke(CHANNELS.dashboard, lectureId, examDate),
  corroborate: (itemId: string) => ipcRenderer.invoke(CHANNELS.corroborate, itemId),
  exportDeck: (lectureId: string | undefined, format: 'anki-tsv' | 'quizlet-csv') =>
    ipcRenderer.invoke(CHANNELS.exportDeck, lectureId, format),

  listDeck: (lectureId?: string) => ipcRenderer.invoke(CHANNELS.listDeck, lectureId),
  addCard: (card: NewUserCard) => ipcRenderer.invoke(CHANNELS.addCard, card),
  editCard: (edit: CardEdit) => ipcRenderer.invoke(CHANNELS.editCard, edit),
  deleteCard: (itemId: string) => ipcRenderer.invoke(CHANNELS.deleteCard, itemId),
  importDeck: (lectureId: string) => ipcRenderer.invoke(CHANNELS.importDeck, lectureId),
  vouchCard: (itemId: string) => ipcRenderer.invoke(CHANNELS.vouchCard, itemId),
  appInfo: () => ipcRenderer.invoke(CHANNELS.appInfo),
};

contextBridge.exposeInMainWorld('nursedeck', bridge);

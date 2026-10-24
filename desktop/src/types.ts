export type Provider = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  appId: string;
  secretId: string;
};
export type Settings = {
  theme?: "light"|"dark"|"system";
  closeAction?: "tray"|"quit";
  captureProtection: boolean;
  asrProvider: string;
  ocrProvider?: string;
  activeModel: string;
  screenshotModel?: string;
  providers: Provider[];
  network: { mode: string; url: string };
  shortcuts: { answer: string; cancel: string; toggle: string; screen?: string; manual?: string };
  screenCapture?: { confirmBeforeAnswer: boolean; shiftDoubleClick: boolean };
  job: string;
  silenceMs: number;
  fontSize: number;
  answerOpacity?: number;
  answerWords?: number;
  shortcutPresetVersion?: number;
};
export type AudioSource = {
  id: string;
  name: string;
  kind: string;
  pid: number | null;
  recommended: boolean;
};
export type Session = {
  id: string;
  title: string;
  createdAt: number;
  endedAt: number | null;
};
export type Transcript = {
  id: string;
  sessionId: string;
  source: string;
  segmentId: string;
  text: string;
  isFinal: boolean;
  at: number;
  speechEndAt: number;
};
export type MaterialSource = {materialId:string;title:string;kind:string;excerpt:string};
export type Answer = {
  sources?: MaterialSource[];
  id: string;
  sessionId: string;
  questionId: string;
  revision: number;
  question: string;
  text: string;
  status: string;
  mode: string;
  createdAt: number;
  speechEndAt: number;
  triggerAt: number;
  requestAt: number;
  firstTokenMs: number | null;
  firstSentenceMs: number | null;
};
export type Material = {
  id: string;
  title: string;
  kind: string;
  text: string;
  enabled: boolean;
  updatedAt: number;
};
export type Notice = {
  source: string;
  message: string;
  error: boolean;
  at: number;
};
export type CaptureProtectionStatus = {
  requested: boolean;
  state: "pending" | "enabled" | "disabled" | "blocked";
  windows: Record<string, number>;
  message: string | null;
};
export type ScreenCaptureState = { version: number; jobId: string; sessionId: string; stage: "idle"|"capturing"|"recognizing"|"ready"|"answering"|"answered"|"error"; text: string; error: string; fallback?: boolean; questionId: string };
export type Snapshot = {
  screenCapture?: ScreenCaptureState;
  captureProtection?: CaptureProtectionStatus;
  notices: Notice[];
  warnings: string[];
  settings: Settings;
  configured: string[];
  session: Session | null;
  transcripts: Transcript[];
  answers: Answer[];
  materials: Material[];
  sessions: Session[];
};
export type SessionEvent = {
  theme?: "light"|"dark"|"system";
  opacity?: number;
  screenCapture?: ScreenCaptureState;
  enabled?: boolean;
  type: string;
  sessionId: string;
  session?: Session;
  transcript?: Transcript;
  answer?: Answer;
  source?: string;
  level?: number;
  message?: string;
  error?: boolean;
  at?: number;
};
export type SecretUpdate = {
  id: string;
  secret: { apiKey: string; secretKey: string };
};

export type ReviewReadingState = {tab:string;expanded:string[];current:string;positions:Record<string,number>};

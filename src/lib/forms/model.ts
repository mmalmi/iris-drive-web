/**
 * A form: its questions and settings, kept in the form's Yjs document so
 * several people can edit it at once, like the other document kinds.
 *
 * `form` holds the description and settings; `questions` holds one map per
 * question. The inbox is the public half of where answers are sent (see
 * inbox.ts): anyone who can open the form can answer it, nobody else can.
 */
import * as Y from 'yjs';

export type QuestionType = 'short' | 'paragraph' | 'choice' | 'checkboxes' | 'dropdown' | 'date';

/** Who may answer: anyone who has the form, or only people near the owner in the follow graph. */
export type Who = 'anyone' | 'network';

export interface Question {
  id: string;
  type: QuestionType;
  title: string;
  /** A line under the question. */
  help: string;
  required: boolean;
  /** The choices, for the kinds that have them. */
  options: string[];
}

export interface Inbox {
  /** Hex public key answers are sent to. */
  pubkey: string;
  /** Hex secret only those who can open the form know. */
  secret: string;
}

export interface FormData {
  description: string;
  questions: Question[];
  who: Who;
  /** With `network`: the largest follow distance whose answers are kept. */
  reach: number;
  inbox: Inbox | null;
  /** Whether answers are taken. */
  open: boolean;
}

export type Answer = string | string[];
export type Answers = Record<string, Answer>;

export const QUESTION_TYPES: Array<{ type: QuestionType; label: string; icon: string }> = [
  { type: 'short', label: 'Short answer', icon: 'i-lucide-text-cursor-input' },
  { type: 'paragraph', label: 'Paragraph', icon: 'i-lucide-align-left' },
  { type: 'choice', label: 'Multiple choice', icon: 'i-lucide-circle-dot' },
  { type: 'checkboxes', label: 'Checkboxes', icon: 'i-lucide-square-check' },
  { type: 'dropdown', label: 'Dropdown', icon: 'i-lucide-chevron-down-circle' },
  { type: 'date', label: 'Date', icon: 'i-lucide-calendar' },
];

export const REACH_CHOICES: Array<{ reach: number; label: string }> = [
  { reach: 1, label: 'People you follow' },
  { reach: 2, label: 'People you follow and the people they follow' },
  { reach: 3, label: 'Up to three steps away' },
];

export const DEFAULT_REACH = 2;
const MAX_REACH = 3;
const QUESTION_KEYS = ['id', 'type', 'title', 'help', 'required', 'options'] as const;

export function hasOptions(type: QuestionType): boolean {
  return type === 'choice' || type === 'checkboxes' || type === 'dropdown';
}

function isQuestionType(value: unknown): value is QuestionType {
  return QUESTION_TYPES.some((item) => item.type === value);
}

function settings(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap('form');
}

function questionList(ydoc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return ydoc.getArray<Y.Map<unknown>>('questions');
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readInbox(value: unknown): Inbox | null {
  if (!value || typeof value !== 'object') return null;
  const { pubkey, secret } = value as Record<string, unknown>;
  const hex = (text: unknown): text is string => typeof text === 'string' && /^[0-9a-f]{64}$/.test(text);
  return hex(pubkey) && hex(secret) ? { pubkey, secret } : null;
}

function readQuestion(map: Y.Map<unknown>): Question | null {
  const id = map.get('id');
  const type = map.get('type');
  if (typeof id !== 'string' || !id || !isQuestionType(type)) return null;
  const options = map.get('options');
  return {
    id,
    type,
    title: String(map.get('title') ?? ''),
    help: String(map.get('help') ?? ''),
    required: map.get('required') === true,
    options: options instanceof Y.Array ? options.toArray().map(String) : [],
  };
}

/** The form as it is now, as plain data. */
export function readForm(ydoc: Y.Doc): FormData {
  const form = settings(ydoc);
  const reach = Number(form.get('reach'));
  const seen = new Set<string>();
  const questions: Question[] = [];
  for (const map of questionList(ydoc).toArray()) {
    const question = readQuestion(map);
    // Two people duplicating at once can not make one id twice, but a copy pasted in could.
    if (!question || seen.has(question.id)) continue;
    seen.add(question.id);
    questions.push(question);
  }
  return {
    description: String(form.get('description') ?? ''),
    questions,
    who: form.get('who') === 'network' ? 'network' : 'anyone',
    reach: Number.isInteger(reach) && reach >= 1 && reach <= MAX_REACH ? reach : DEFAULT_REACH,
    inbox: readInbox(form.get('inbox')),
    open: form.get('open') !== false,
  };
}

function findQuestion(ydoc: Y.Doc, id: string): { index: number; map: Y.Map<unknown> } | null {
  const list = questionList(ydoc);
  for (let index = 0; index < list.length; index += 1) {
    const map = list.get(index);
    if (map.get('id') === id) return { index, map };
  }
  return null;
}

function questionMap(question: Omit<Question, 'id'>, id = newId()): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', id);
  map.set('type', question.type);
  map.set('title', question.title);
  map.set('help', question.help);
  map.set('required', question.required);
  const options = new Y.Array<string>();
  options.push(question.options);
  map.set('options', options);
  return map;
}

/** Adds a question after `after` (at the end without it) and returns its id. */
export function addQuestion(ydoc: Y.Doc, type: QuestionType = 'choice', after?: string): string {
  const id = newId();
  ydoc.transact(() => {
    const list = questionList(ydoc);
    const at = after ? findQuestion(ydoc, after) : null;
    list.insert(at ? at.index + 1 : list.length, [questionMap({
      type,
      title: '',
      help: '',
      required: false,
      options: hasOptions(type) ? ['Option 1'] : [],
    }, id)]);
  });
  return id;
}

export function duplicateQuestion(ydoc: Y.Doc, id: string): string | null {
  const found = findQuestion(ydoc, id);
  const question = found ? readQuestion(found.map) : null;
  if (!found || !question) return null;
  const copy = newId();
  ydoc.transact(() => {
    questionList(ydoc).insert(found.index + 1, [questionMap(question, copy)]);
  });
  return copy;
}

export function removeQuestion(ydoc: Y.Doc, id: string): void {
  const found = findQuestion(ydoc, id);
  if (found) questionList(ydoc).delete(found.index, 1);
}

/** Moves a question up (-1) or down (+1). */
export function moveQuestion(ydoc: Y.Doc, id: string, by: -1 | 1): void {
  const found = findQuestion(ydoc, id);
  const question = found ? readQuestion(found.map) : null;
  if (!found || !question) return;
  const list = questionList(ydoc);
  const to = found.index + by;
  if (to < 0 || to >= list.length) return;
  ydoc.transact(() => {
    list.delete(found.index, 1);
    list.insert(to, [questionMap(question, question.id)]);
  });
}

export function updateQuestion(
  ydoc: Y.Doc,
  id: string,
  patch: Partial<Pick<Question, 'type' | 'title' | 'help' | 'required'>>,
): void {
  const found = findQuestion(ydoc, id);
  if (!found) return;
  ydoc.transact(() => {
    for (const key of QUESTION_KEYS) {
      if (key === 'id' || key === 'options' || !(key in patch)) continue;
      found.map.set(key, patch[key]);
    }
    // A question that now offers choices starts with one.
    const options = found.map.get('options');
    if (patch.type && hasOptions(patch.type) && options instanceof Y.Array && options.length === 0) options.push(['Option 1']);
  });
}

function optionsOf(ydoc: Y.Doc, id: string): Y.Array<string> | null {
  const options = findQuestion(ydoc, id)?.map.get('options');
  return options instanceof Y.Array ? options as Y.Array<string> : null;
}

export function setOption(ydoc: Y.Doc, id: string, index: number, text: string): void {
  const options = optionsOf(ydoc, id);
  if (!options || index < 0 || index >= options.length || options.get(index) === text) return;
  ydoc.transact(() => {
    options.delete(index, 1);
    options.insert(index, [text]);
  });
}

/** Adds a choice named after its place, and returns its index. */
export function addOption(ydoc: Y.Doc, id: string): number {
  const options = optionsOf(ydoc, id);
  if (!options) return -1;
  const taken = new Set(options.toArray());
  let n = options.length + 1;
  while (taken.has(`Option ${n}`)) n += 1;
  options.push([`Option ${n}`]);
  return options.length - 1;
}

export function removeOption(ydoc: Y.Doc, id: string, index: number): void {
  const options = optionsOf(ydoc, id);
  if (options && index >= 0 && index < options.length && options.length > 1) options.delete(index, 1);
}

export function updateForm(ydoc: Y.Doc, patch: Partial<Pick<FormData, 'description' | 'who' | 'reach' | 'open'>>): void {
  const form = settings(ydoc);
  ydoc.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (form.get(key) !== value) form.set(key, value);
    }
  });
}

/**
 * Gives a new form its inbox and first question. Two devices doing this at
 * once both write an inbox; one wins, and the other's key is never used.
 */
export function seedForm(ydoc: Y.Doc, inbox: Inbox): void {
  ydoc.transact(() => {
    const form = settings(ydoc);
    if (!readInbox(form.get('inbox'))) form.set('inbox', { pubkey: inbox.pubkey, secret: inbox.secret });
    if (questionList(ydoc).length === 0) addQuestion(ydoc, 'choice');
  });
}

function answered(question: Question, value: Answer | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Answers as they arrive: any well-formed values, by question id. They are
 * kept as sent, so a question or choice renamed later still shows what was
 * picked, and only the questions the form still has are shown.
 */
export function readAnswers(raw: unknown): Answers {
  const answers: Answers = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return answers;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
    if (!/^[0-9a-f]{1,32}$/.test(id)) continue;
    if (typeof value === 'string') answers[id] = value.slice(0, 10_000);
    else if (Array.isArray(value)) answers[id] = value.filter((item): item is string => typeof item === 'string').slice(0, 100).map((item) => item.slice(0, 1000));
  }
  return answers;
}

/**
 * What a person sends: only answers to questions the form has, of the shape
 * their kind takes, and choices it offers.
 */
export function cleanAnswers(form: Pick<FormData, 'questions'>, raw: unknown): Answers {
  const clean: Answers = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
  const given = raw as Record<string, unknown>;
  for (const question of form.questions) {
    const value = given[question.id];
    if (question.type === 'checkboxes') {
      if (!Array.isArray(value)) continue;
      const picked = question.options.filter((option) => value.includes(option));
      if (picked.length > 0) clean[question.id] = picked;
    } else if (typeof value === 'string' && value.trim()) {
      if (hasOptions(question.type) && !question.options.includes(value)) continue;
      if (question.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
      clean[question.id] = value.slice(0, 10_000);
    }
  }
  return clean;
}

/** The ids of required questions left unanswered. */
export function missingAnswers(form: Pick<FormData, 'questions'>, answers: Answers): string[] {
  return form.questions.filter((question) => question.required && !answered(question, answers[question.id])).map((question) => question.id);
}

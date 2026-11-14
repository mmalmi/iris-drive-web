/**
 * How a form's responses and inbox key are written, in the hidden folder of
 * its maker's My Drive (see formStore.ts). Each response is one file, written
 * once: every device that takes it in writes the same bytes under the same
 * name, so devices doing it at once merge cleanly.
 */
import { readAnswers, hasOptions, type Answer, type Answers, type Question } from './model';

export const KEY_FILE = 'key.json';
export const RESPONSES_DIRECTORY = 'responses';

export interface FormResponse {
  id: string;
  /** Unix seconds. */
  at: number;
  /** Who sent it, for a form that asks people to sign in; null when anonymous. */
  from: string | null;
  /** Their Drive profile and name as they gave them, to show while their profile is not found. */
  profile?: string;
  name?: string;
  answers: Answers;
}

export function encodeInboxKey(pubkey: string, privateKey: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, pubkey, privateKey }));
}

export function decodeInboxKey(data: Uint8Array, pubkey: string): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as { pubkey?: unknown; privateKey?: unknown };
    return parsed.pubkey === pubkey && typeof parsed.privateKey === 'string' && /^[0-9a-f]{64}$/.test(parsed.privateKey)
      ? parsed.privateKey
      : null;
  } catch {
    return null;
  }
}

export function responseFileName(id: string): string {
  return `${id}.json`;
}

/** The response id a file name holds, or null for anything else. */
export function responseIdOf(fileName: string): string | null {
  const match = /^([0-9a-f]{64})\.json$/.exec(fileName);
  return match ? match[1]! : null;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** The same response always gives the same bytes. */
export function encodeResponse(response: FormResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sorted({ v: 1, ...response })));
}

export function decodeResponse(data: Uint8Array): FormResponse | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    const id = typeof parsed.id === 'string' && /^[0-9a-f]{64}$/.test(parsed.id) ? parsed.id : null;
    const at = Number(parsed.at);
    if (!id || !Number.isFinite(at)) return null;
    const from = typeof parsed.from === 'string' && /^[0-9a-f]{64}$/.test(parsed.from) ? parsed.from : null;
    const profile = from && typeof parsed.profile === 'string' ? parsed.profile.slice(0, 128) : undefined;
    const name = from && typeof parsed.name === 'string' ? parsed.name.slice(0, 100) : undefined;
    return { id, at, from, ...(profile ? { profile } : {}), ...(name ? { name } : {}), answers: readAnswers(parsed.answers) };
  } catch {
    return null;
  }
}

/** An answer as one line of text. */
export function answerText(answer: Answer | undefined): string {
  if (answer === undefined) return '';
  return Array.isArray(answer) ? answer.join(', ') : answer;
}

function csvCell(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Responses as CSV, oldest first: when, who for a signed form, then one column per question. */
export function responsesCsv(questions: Question[], responses: FormResponse[], withSender: boolean, nameOf: (response: FormResponse) => string = (response) => response.name ?? response.from ?? ''): string {
  const header = ['Timestamp', ...(withSender ? ['From'] : []), ...questions.map((question) => question.title || 'Untitled question')];
  const rows = [...responses].sort((a, b) => a.at - b.at).map((response) => [
    new Date(response.at * 1000).toISOString(),
    ...(withSender ? [response.from ? nameOf(response) : ''] : []),
    ...questions.map((question) => answerText(response.answers[question.id])),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export interface ChoiceCount {
  option: string;
  count: number;
}

/**
 * How often each choice was picked, in the question's order, then any picked
 * choices it no longer offers. Null for questions answered in words.
 */
export function choiceCounts(question: Question, responses: FormResponse[]): ChoiceCount[] | null {
  if (!hasOptions(question.type)) return null;
  const counts = new Map<string, number>(question.options.map((option) => [option, 0]));
  for (const response of responses) {
    const answer = response.answers[question.id];
    for (const picked of Array.isArray(answer) ? answer : answer ? [answer] : []) {
      counts.set(picked, (counts.get(picked) ?? 0) + 1);
    }
  }
  return [...counts].map(([option, count]) => ({ option, count }));
}

/** How many responses answered the question. */
export function answeredCount(question: Question, responses: FormResponse[]): number {
  return responses.filter((response) => answerText(response.answers[question.id]).trim() !== '').length;
}

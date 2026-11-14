import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addOption,
  addQuestion,
  cleanAnswers,
  duplicateQuestion,
  missingAnswers,
  moveQuestion,
  readAnswers,
  readForm,
  removeOption,
  removeQuestion,
  seedForm,
  setOption,
  updateForm,
  updateQuestion,
} from '../src/lib/forms/model';
import {
  choiceCounts,
  decodeInboxKey,
  decodeResponse,
  encodeInboxKey,
  encodeResponse,
  responseIdOf,
  responsesCsv,
  type FormResponse,
} from '../src/lib/forms/responses';
import { documentKind, documentFolderName } from '../src/lib/documentNames';

const HEX = 'a'.repeat(64);
const inbox = { pubkey: 'b'.repeat(64), secret: 'c'.repeat(64) };

describe('form model', () => {
  it('is a document kind of its own', () => {
    expect(documentKind('Survey.irisform')).toBe('form');
    expect(documentFolderName('Survey', 'form')).toBe('Survey.irisform');
  });

  it('starts with an inbox and one choice question, and keeps the first inbox', () => {
    const ydoc = new Y.Doc();
    seedForm(ydoc, inbox);
    seedForm(ydoc, { pubkey: 'd'.repeat(64), secret: 'e'.repeat(64) });
    const form = readForm(ydoc);
    expect(form.inbox).toEqual(inbox);
    expect(form.questions).toHaveLength(1);
    expect(form.questions[0]).toMatchObject({ type: 'choice', options: ['Option 1'], required: false });
    expect(form).toMatchObject({ who: 'anyone', reach: 2, open: true, description: '' });
  });

  it('edits, orders, copies and removes questions and choices', () => {
    const ydoc = new Y.Doc();
    const first = addQuestion(ydoc, 'short');
    const second = addQuestion(ydoc, 'checkboxes');
    updateQuestion(ydoc, first, { title: 'Name', required: true });
    setOption(ydoc, second, 0, 'Red');
    expect(addOption(ydoc, second)).toBe(1);
    setOption(ydoc, second, 1, 'Blue');
    moveQuestion(ydoc, second, -1);
    let form = readForm(ydoc);
    expect(form.questions.map((question) => question.id)).toEqual([second, first]);
    expect(form.questions[0]!.options).toEqual(['Red', 'Blue']);

    const copy = duplicateQuestion(ydoc, second)!;
    removeOption(ydoc, copy, 0);
    form = readForm(ydoc);
    expect(form.questions.map((question) => question.id)).toEqual([second, copy, first]);
    expect(form.questions[1]!.options).toEqual(['Blue']);
    // The last choice stays.
    removeOption(ydoc, copy, 0);
    expect(readForm(ydoc).questions[1]!.options).toEqual(['Blue']);

    removeQuestion(ydoc, copy);
    updateQuestion(ydoc, first, { type: 'dropdown' });
    form = readForm(ydoc);
    expect(form.questions).toHaveLength(2);
    expect(form.questions[1]).toMatchObject({ type: 'dropdown', options: ['Option 1'], title: 'Name' });
  });

  it('merges two people editing at once', () => {
    const one = new Y.Doc();
    seedForm(one, inbox);
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    addQuestion(one, 'short');
    addQuestion(two, 'paragraph');
    updateForm(two, { who: 'network', reach: 1 });
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    expect(readForm(one)).toEqual(readForm(two));
    expect(readForm(one).questions).toHaveLength(3);
    expect(readForm(one)).toMatchObject({ who: 'network', reach: 1 });
  });

  it('sends only answers the form asks for, and tells which required ones are missing', () => {
    const ydoc = new Y.Doc();
    const name = addQuestion(ydoc, 'short');
    const pick = addQuestion(ydoc, 'choice');
    const many = addQuestion(ydoc, 'checkboxes');
    const day = addQuestion(ydoc, 'date');
    addOption(ydoc, many);
    updateQuestion(ydoc, name, { required: true });
    updateQuestion(ydoc, pick, { required: true });
    const form = readForm(ydoc);
    expect(missingAnswers(form, { [name]: '  ' })).toEqual([name, pick]);
    expect(cleanAnswers(form, {
      [name]: 'Ada',
      [pick]: 'Not offered',
      [many]: ['Option 2', 'Nope', 'Option 1'],
      [day]: 'tomorrow',
      other: 'x',
    })).toEqual({ [name]: 'Ada', [many]: ['Option 1', 'Option 2'] });
  });

  it('keeps answers as they came, so renamed choices still show what was picked', () => {
    expect(readAnswers({ abc: 'Old choice', def: ['x', 1, 'y'], 'not an id': 'z', ghi: 5 })).toEqual({ abc: 'Old choice', def: ['x', 'y'] });
    expect(readAnswers('nope')).toEqual({});
  });
});

describe('form responses', () => {
  const response: FormResponse = { id: HEX, at: 1_700_000_000, from: null, answers: { b: ['x'], a: 'Hi, "you"' } };

  it('writes the same bytes for the same response, and reads them back', () => {
    const shuffled = { ...response, answers: { a: 'Hi, "you"', b: ['x'] } };
    expect(encodeResponse(shuffled)).toEqual(encodeResponse(response));
    expect(decodeResponse(encodeResponse(response))).toEqual(response);
    expect(decodeResponse(new TextEncoder().encode('{"id":"short"}'))).toBeNull();
    expect(responseIdOf(`${HEX}.json`)).toBe(HEX);
    expect(responseIdOf('key.json')).toBeNull();
  });

  it('keeps the inbox key only for its own inbox', () => {
    const data = encodeInboxKey(inbox.pubkey, HEX);
    expect(decodeInboxKey(data, inbox.pubkey)).toBe(HEX);
    expect(decodeInboxKey(data, 'f'.repeat(64))).toBeNull();
  });

  it('counts choices and exports CSV oldest first', () => {
    const ydoc = new Y.Doc();
    const q = addQuestion(ydoc, 'choice');
    addOption(ydoc, q);
    updateQuestion(ydoc, q, { title: 'Pick, one' });
    const form = readForm(ydoc);
    const responses: FormResponse[] = [
      { id: 'b'.repeat(64), at: 200, from: 'c'.repeat(64), answers: { [q]: 'Option 2' } },
      { id: 'a'.repeat(64), at: 100, from: null, answers: { [q]: 'Gone' } },
    ];
    expect(choiceCounts(form.questions[0]!, responses)).toEqual([
      { option: 'Option 1', count: 0 },
      { option: 'Option 2', count: 1 },
      { option: 'Gone', count: 1 },
    ]);
    expect(responsesCsv(form.questions, responses, true, (response) => response.name ?? 'Cy').split('\r\n')).toEqual([
      'Timestamp,From,"Pick, one"',
      '1970-01-01T00:01:40.000Z,,Gone',
      '1970-01-01T00:03:20.000Z,Cy,Option 2',
    ]);
  });
});

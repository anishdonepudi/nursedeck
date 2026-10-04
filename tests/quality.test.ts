import { describe, it, expect } from 'vitest';
import { checkFlashcard, checkCloze, checkNclex } from '@core/validate/quality.js';
import type { GeneratedNclex } from '@core/generate/schemas.js';

/**
 * Each case here is a real failure mode of LLM-written study material, or a
 * documented NBME/PNCB item flaw. Good items must survive untouched (no false
 * positives), because an over-eager checker that rejects sound cards is just as
 * useless as no checker at all.
 */

const citation = { blockOrdinal: 1, excerpt: 'x'.repeat(30) };

describe('checkFlashcard', () => {
  it('accepts a clean, single-fact card', () => {
    const r = checkFlashcard({
      front: 'What is the normal adult serum potassium range?',
      back: '3.5-5.0 mEq/L',
      citation,
    });
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === 'reject')).toHaveLength(0);
  });

  it('REJECTS a paragraph answer', () => {
    const r = checkFlashcard({
      front: 'What is hypokalemia?',
      back: 'Hypokalemia is a condition in which the serum potassium concentration falls below the lower limit of normal, which may arise from gastrointestinal losses, renal losses, or transcellular shifts, and which can produce dysrhythmias.',
      citation,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('answer_too_long');
  });

  it('REJECTS a card whose answer is already in the question', () => {
    const r = checkFlashcard({
      front: 'Potassium is the major intracellular cation — which cation is it?',
      back: 'the major intracellular cation',
      citation,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('answer_in_question');
  });

  it('REJECTS empty sides', () => {
    expect(checkFlashcard({ front: '', back: 'A', citation }).ok).toBe(false);
    expect(checkFlashcard({ front: 'Q?', back: '  ', citation }).ok).toBe(false);
  });

  it('warns, but does not reject, an oddly phrased prompt', () => {
    const r = checkFlashcard({ front: 'Potassium range', back: '3.5-5.0 mEq/L', citation });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.rule)).toContain('undirected_question');
  });
});

describe('checkCloze', () => {
  it('accepts a blank over the information-carrying value', () => {
    const r = checkCloze({
      text: 'Normal adult serum potassium is {{3.5-5.0 mEq/L}}.',
      answer: '3.5-5.0 mEq/L',
      citation,
    });
    expect(r.ok).toBe(true);
  });

  it('REJECTS a blank over a function word — the classic bad cloze', () => {
    const r = checkCloze({
      text: 'Normal adult serum potassium {{is}} 3.5-5.0 mEq/L.',
      answer: 'is',
      citation,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('low_information_blank');
  });

  it('REJECTS two blanks in one sentence', () => {
    const r = checkCloze({
      text: 'Normal {{potassium}} is {{3.5-5.0}} mEq/L.',
      answer: 'potassium',
      citation,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('multiple_blanks');
  });

  it('REJECTS a sentence with no blank at all', () => {
    const r = checkCloze({ text: 'Normal potassium is 3.5-5.0 mEq/L.', answer: 'x', citation });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('no_blank');
  });

  it('REJECTS a mismatch between the blank and the stated answer', () => {
    const r = checkCloze({
      text: 'Normal potassium is {{3.5-5.0 mEq/L}}.',
      answer: '135-145 mEq/L',
      citation,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('answer_mismatch');
  });

  it('REJECTS a blank with almost no surrounding context', () => {
    const r = checkCloze({ text: '{{3.5-5.0 mEq/L}} range', answer: '3.5-5.0 mEq/L', citation });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('insufficient_context');
  });
});

/* ------------------------------------------------------------------ */

function nclex(over: Partial<GeneratedNclex> = {}): GeneratedNclex {
  return {
    stem:
      'A nurse is caring for a client who is 4 hours post-thyroidectomy. The client reports ' +
      'tingling around the mouth and has audible stridor. Which action should the nurse take first?',
    itemType: 'multiple_choice',
    clientNeed: 'Physiological Adaptation',
    njcmmStep: 'Take Action',
    cognitiveLevel: 'analysis',
    citation,
    options: [
      { text: 'Assess the airway and prepare for emergency intubation', isKey: true, rationale: 'Stridor indicates airway compromise; airway precedes all else.' },
      { text: 'Obtain a serum calcium level', isKey: false, rationale: 'Appropriate for the tingling, but airway comes first.', errorClass: 'right-action-wrong-order' },
      { text: 'Document the findings and continue to monitor', isKey: false, rationale: 'Monitoring alone delays treatment of an airway emergency.', errorClass: 'passive-action' },
      { text: 'Reposition the client to a left lateral position', isKey: false, rationale: 'Does not relieve post-operative airway obstruction.', errorClass: 'irrelevant-intervention' },
    ],
    ...over,
  };
}

describe('checkNclex', () => {
  it('accepts a well-formed vignette item', () => {
    const r = checkNclex(nclex());
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === 'reject')).toHaveLength(0);
  });

  it('REJECTS an item with no correct option', () => {
    const item = nclex();
    item.options = item.options.map((o) => ({ ...o, isKey: false }));
    const r = checkNclex(item);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('no_key');
  });

  it('REJECTS two keys on a single-answer item', () => {
    const item = nclex();
    item.options[1]!.isKey = true;
    const r = checkNclex(item);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('multiple_keys');
  });

  it('REJECTS "all of the above"', () => {
    const item = nclex();
    item.options[3]!.text = 'All of the above';
    const r = checkNclex(item);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('all_or_none_of_above');
  });

  it('REJECTS a distractor with no rationale', () => {
    const item = nclex();
    item.options[2]!.rationale = '';
    const r = checkNclex(item);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('missing_rationale');
  });

  it('REJECTS duplicate options', () => {
    const item = nclex();
    item.options[3]!.text = item.options[2]!.text;
    const r = checkNclex(item);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('duplicate_options');
  });

  it('REJECTS a select-N item whose key count disagrees with the stem', () => {
    const item = nclex({ itemType: 'select_n', selectN: 3 });
    const r = checkNclex(item); // only one key
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('select_n_mismatch');
  });

  it('REJECTS a select-all item where every option is correct', () => {
    const item = nclex({ itemType: 'select_all' });
    item.options = item.options.map((o) => ({ ...o, isKey: true }));
    const r = checkNclex(item);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('all_options_keyed');
  });

  it('warns on a negatively worded lead-in', () => {
    const item = nclex({
      stem: 'A client is post-thyroidectomy with stridor. Which action should the nurse NOT take?',
    });
    expect(checkNclex(item).issues.map((i) => i.rule)).toContain('negative_stem');
  });

  it('does NOT warn on a contraindication item, where the negative is the point', () => {
    const item = nclex({
      stem:
        'A client with a history of asthma is prescribed a beta blocker for hypertension. ' +
        'Which finding indicates the medication is contraindicated for this client?',
    });
    expect(checkNclex(item).issues.map((i) => i.rule)).not.toContain('negative_stem');
  });

  it('warns on absolute terms in options', () => {
    const item = nclex();
    item.options[3]!.text = 'Always reposition the client before assessing';
    expect(checkNclex(item).issues.map((i) => i.rule)).toContain('absolute_terms');
  });

  it('warns when the key is conspicuously longer than every distractor', () => {
    const item = nclex();
    item.options[0]!.text =
      'Assess the airway immediately and prepare for emergency intubation because stridor ' +
      'after thyroidectomy indicates an expanding haematoma compressing the trachea';
    item.options = item.options.map((o, idx) => (idx === 0 ? o : { ...o, text: 'Monitor' }));
    expect(checkNclex(item).issues.map((i) => i.rule)).toContain('key_stands_out');
  });

  it('warns on "patient" instead of the NCLEX term "client"', () => {
    const item = nclex({
      stem: 'A nurse is caring for a patient who is 4 hours post-thyroidectomy with stridor. Which action should the nurse take first?',
    });
    expect(checkNclex(item).issues.map((i) => i.rule)).toContain('terminology_patient');
  });

  it('warns on a stem with no vignette', () => {
    const item = nclex({ stem: 'What is hypokalemia?' });
    expect(checkNclex(item).issues.map((i) => i.rule)).toContain('no_vignette');
  });

  it('warns on a clang clue linking the stem to only the key', () => {
    const item = nclex({
      stem:
        'A client develops laryngospasm following extubation after a long procedure in theatre. ' +
        'Which intervention should the nurse anticipate for this complication?',
      options: [
        { text: 'Administer a medication that relieves laryngospasm', isKey: true, rationale: 'Correct.' },
        { text: 'Increase the intravenous fluid rate', isKey: false, rationale: 'Unrelated.' },
        { text: 'Place the client in a prone position', isKey: false, rationale: 'Unrelated.' },
        { text: 'Obtain a chest radiograph', isKey: false, rationale: 'Unrelated.' },
      ],
    });
    expect(checkNclex(item).issues.map((i) => i.rule)).toContain('clang_clue');
  });
});

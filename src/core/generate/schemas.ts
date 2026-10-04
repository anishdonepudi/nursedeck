/**
 * JSON Schemas for generated content.
 *
 * Draft-07 specifically: the Claude CLI's validator rejects newer drafts. Each
 * schema is `additionalProperties: false` so the model cannot smuggle extra
 * fields past validation, and every content type REQUIRES a citation —
 * generation cannot produce an unsourced claim and have it validate.
 */

/** One piece of supporting evidence, quoted verbatim from the lecture. */
const CITATION = {
  type: 'object',
  properties: {
    blockOrdinal: {
      type: 'integer',
      description: 'The slide number this came from, exactly as labelled in the input.',
    },
    excerpt: {
      type: 'string',
      description:
        'A VERBATIM quote from that slide that proves the answer. Copy it character for character; do not paraphrase, correct, or shorten it except with an ellipsis.',
    },
  },
  required: ['blockOrdinal', 'excerpt'],
  additionalProperties: false,
} as const;

export const FLASHCARD_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          front: { type: 'string', description: 'The question. One fact only.' },
          back: { type: 'string', description: 'The answer. At most 20 words.' },
          citation: CITATION,
          cognitiveLevel: { type: 'string', enum: ['recall', 'application', 'analysis'] },
          topic: { type: 'string' },
        },
        required: ['front', 'back', 'citation'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
} as const;

export const CLOZE_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'The full sentence with exactly one span wrapped in {{...}}. The blank must be the word or value carrying the information, never a word guessable from grammar alone.',
          },
          answer: { type: 'string', description: 'The text inside the braces.' },
          citation: CITATION,
          topic: { type: 'string' },
        },
        required: ['text', 'answer', 'citation'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
} as const;

export const QA_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'An open question requiring explanation.' },
          modelAnswer: { type: 'string' },
          // Grading an open answer needs criteria, not a single expected string.
          keyPoints: {
            type: 'array',
            items: { type: 'string' },
            description: 'The points a complete answer must contain.',
          },
          citation: CITATION,
          topic: { type: 'string' },
        },
        required: ['question', 'modelAnswer', 'keyPoints', 'citation'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

/** NCLEX client-need subcategories, per the 2026 RN test plan. */
export const CLIENT_NEEDS = [
  'Management of Care',
  'Safety and Infection Prevention and Control',
  'Health Promotion and Maintenance',
  'Psychosocial Integrity',
  'Basic Care and Comfort',
  'Pharmacological and Parenteral Therapies',
  'Reduction of Risk Potential',
  'Physiological Adaptation',
] as const;

/** The six cognitive operations of the NCSBN Clinical Judgment model. */
export const NJCMM_STEPS = [
  'Recognize Cues',
  'Analyze Cues',
  'Prioritize Hypotheses',
  'Generate Solutions',
  'Take Action',
  'Evaluate Outcomes',
] as const;

export const NCLEX_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // A clinical vignette, in the NBME element order.
          stem: {
            type: 'string',
            description:
              'The client scenario followed by a focused, positively worded lead-in question.',
          },
          itemType: {
            type: 'string',
            enum: ['multiple_choice', 'select_all', 'select_n'],
          },
          selectN: {
            type: 'integer',
            description: 'Required when itemType is select_n: how many options to choose.',
          },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                isKey: { type: 'boolean' },
                // Per-option rationale is what turns a practice item into
                // teaching rather than scoring.
                rationale: {
                  type: 'string',
                  description: 'Why this option is correct, or precisely why it is wrong.',
                },
                errorClass: {
                  type: 'string',
                  description:
                    'For distractors: the misconception it represents, e.g. correct-action-wrong-condition, pertinent-negative-trap.',
                },
              },
              required: ['text', 'isKey', 'rationale'],
              additionalProperties: false,
            },
            minItems: 4,
          },
          clientNeed: { type: 'string', enum: CLIENT_NEEDS as unknown as string[] },
          njcmmStep: { type: 'string', enum: NJCMM_STEPS as unknown as string[] },
          cognitiveLevel: { type: 'string', enum: ['application', 'analysis'] },
          citation: CITATION,
          topic: { type: 'string' },
        },
        required: ['stem', 'itemType', 'options', 'clientNeed', 'njcmmStep', 'citation'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

/* ----------------------------- parsed shapes ----------------------------- */

export interface GeneratedCitation {
  blockOrdinal: number;
  excerpt: string;
}

export interface GeneratedFlashcard {
  front: string;
  back: string;
  citation: GeneratedCitation;
  cognitiveLevel?: 'recall' | 'application' | 'analysis';
  topic?: string;
}

export interface GeneratedCloze {
  text: string;
  answer: string;
  citation: GeneratedCitation;
  topic?: string;
}

export interface GeneratedQa {
  question: string;
  modelAnswer: string;
  keyPoints: string[];
  citation: GeneratedCitation;
  topic?: string;
}

export interface GeneratedNclexOption {
  text: string;
  isKey: boolean;
  rationale: string;
  errorClass?: string;
}

export interface GeneratedNclex {
  stem: string;
  itemType: 'multiple_choice' | 'select_all' | 'select_n';
  selectN?: number;
  options: GeneratedNclexOption[];
  clientNeed: string;
  njcmmStep: string;
  cognitiveLevel?: 'application' | 'analysis';
  citation: GeneratedCitation;
  topic?: string;
}

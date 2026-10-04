import { describe, it, expect } from 'vitest';
import { slideText, renderBatch } from '@core/generate/prompts.js';
import { verifyVerbatim } from '@core/validate/citation.js';
import type { LectureBlock } from '@shared/types.js';

/**
 * Transcribed diagram text.
 *
 * On the student's own decks, 18 of 96 slides carry no text at all -- heading,
 * content and nursing note are baked into a picture -- so without this a third
 * of the acid-base lecture produces nothing.
 */

/** Verbatim from slide 20 of her Acid-Base deck, which has no text of its own. */
const IMAGE_ONLY: LectureBlock = {
  id: 'b20',
  ordinal: 20,
  body: '',
  imageRefs: ['slide20-23.png'],
  imageText: [
    'RESPIRATORY ALKALOSIS',
    '',
    'Typical Causes',
    '- Hyperventilation with Anxiety',
    '- Pulmonary Disease',
    '- Ventilator Settings Too High or Too Fast',
    '- High Altitudes',
  ].join('\n'),
};

describe('slideText', () => {
  it('includes transcribed image text', () => {
    const text = slideText(IMAGE_ONLY);
    expect(text).toContain('RESPIRATORY ALKALOSIS');
    expect(text).toContain('Ventilator Settings Too High or Too Fast');
  });

  it('lets a card cite a diagram, which is the whole point', () => {
    // Without the transcript this slide has no citable text at all, so every
    // card from it would be rejected as uncited.
    const quote = 'Typical Causes\n- Hyperventilation with Anxiety';
    expect(verifyVerbatim(quote, slideText(IMAGE_ONLY)).ok).toBe(true);
  });

  it('is the SAME text the model is shown', () => {
    // The generator reads renderBatch and the verifier checks against
    // slideText. Any divergence makes a faithful quote fail verification --
    // which has happened twice in this project, both times with tables.
    const shown = renderBatch([IMAGE_ONLY], 'Acid-Base Balance');
    for (const line of (IMAGE_ONLY.imageText ?? '').split('\n')) {
      if (!line.trim()) continue;
      expect(shown).toContain(line);
      expect(slideText(IMAGE_ONLY)).toContain(line);
    }
  });

  it('marks image text identically in both, so a quote of the label matches', () => {
    expect(renderBatch([IMAGE_ONLY], 'x')).toContain('Text in the image:');
    expect(slideText(IMAGE_ONLY)).toContain('Text in the image:');
  });

  it('still renders a slide that has no pictures', () => {
    const plain: LectureBlock = {
      id: 'b1', ordinal: 1, heading: 'Buffering Systems', body: 'The lungs and kidneys compensate.',
    };
    const text = slideText(plain);
    expect(text).toContain('Buffering Systems');
    expect(text).not.toContain('Text in the image:');
  });

  it('keeps table rendering identical to what the generator saw', () => {
    const withTable: LectureBlock = {
      id: 'b2', ordinal: 2, heading: 'ABG patterns', body: '',
      tables: [
        ['Disorder', 'pH', 'PaCO2'],
        ['Respiratory acidosis', 'down', 'up'],
      ],
    };
    // The row must be self-describing, or a citation to it proves nothing.
    const text = slideText(withTable);
    expect(text).toContain('Respiratory acidosis - pH: down, PaCO2: up');
    expect(renderBatch([withTable], 'x')).toContain('Respiratory acidosis - pH: down, PaCO2: up');
  });
});

describe('citing an image-only slide', () => {
  /**
   * Verbatim from slide 15 of her Acid-Base deck: the slide has no text, so
   * "Text in the image:" is the first line of the slide text. Treating that as
   * the heading produced "Text in the image: ... Kussmaul Respirations", which
   * names a finding and still never says which condition it belongs to.
   */
  const METABOLIC: LectureBlock = {
    id: 'b15',
    ordinal: 15,
    body: '',
    imageRefs: ['slide15-17.jpeg'],
    imageText: [
      'METABOLIC ACIDOSIS',
      'Kussmaul Respirations (Compensatory Hyperventilation)',
      "You've gotta watch that K+ level too - it will go up!",
    ].join('\n'),
  };

  it('never attaches its own marker as the subject', async () => {
    const { qualifyExcerpt } = await import('@core/validate/citation.js');
    const q = qualifyExcerpt('Kussmaul Respirations (Compensatory Hyperventilation)', slideText(METABOLIC));
    expect(q).not.toMatch(/^Text in the image/i);
  });

  it('uses the transcript heading, which is what names the condition', async () => {
    const { qualifyExcerpt } = await import('@core/validate/citation.js');
    const q = qualifyExcerpt('Kussmaul Respirations (Compensatory Hyperventilation)', slideText(METABOLIC));
    expect(q).toContain('METABOLIC ACIDOSIS');
    // Still a real quote: every fragment must be on the slide, in order.
    expect(verifyVerbatim(q, slideText(METABOLIC)).ok).toBe(true);
  });

  it('qualifies the potassium line the same way', async () => {
    const { qualifyExcerpt } = await import('@core/validate/citation.js');
    const q = qualifyExcerpt("You've gotta watch that K+ level too - it will go up!", slideText(METABOLIC));
    expect(q).toContain('METABOLIC ACIDOSIS');
    expect(verifyVerbatim(q, slideText(METABOLIC)).ok).toBe(true);
  });
});

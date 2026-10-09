import { describe, expect, it } from 'vitest';
import { chatByMetadata, compatCaps, looksVision, metadataCaps } from '../../src/llm/catalog';
import { ProviderKinds } from '../../src/llm/providers';
import { defaultCaps } from '../../src/llm/types';

describe('capabilities reported in model lists', () => {
  it('uses Mistral capabilities', () => {
    const caps = metadataCaps(compatCaps(ProviderKinds.MISTRAL, 'mistral-large-4'), { id: 'mistral-large-2512', capabilities: { completion_chat: true, function_calling: true, vision: true } });
    expect(caps.vision).toBe(true);
    expect(caps.tools).toBe(true);
    const text = metadataCaps(compatCaps(ProviderKinds.MISTRAL, 'codestral-latest'), { capabilities: { completion_chat: true, function_calling: false, vision: false } });
    expect(text.vision).toBe(false);
    expect(text.tools).toBe(false);
    expect(chatByMetadata({ capabilities: { completion_chat: false } })).toBe(false);
  });

  it('reads flags, modalities and tags, and keeps guesses when nothing is reported', () => {
    expect(metadataCaps(defaultCaps(), { supports_image_input: true }).vision).toBe(true);
    const hf = metadataCaps(defaultCaps({ tools: false }), { architecture: { input_modalities: ['text', 'image'] }, providers: [{ supports_tools: false }, { supports_tools: true }] });
    expect(hf.vision && hf.tools).toBe(true);
    const v = metadataCaps(defaultCaps(), { tags: ['vision', 'file-input', 'reasoning', 'tool-use'] });
    expect(v.vision && v.pdf && v.tools && v.reasoning.summaries).toBe(true);
    const plain = compatCaps(ProviderKinds.GROQ, 'meta-llama/llama-4-scout');
    expect(metadataCaps(plain, { id: 'x', context_window: 1 })).toEqual(plain);
    expect(looksVision('magistral-medium-latest')).toBe(true);
  });
});

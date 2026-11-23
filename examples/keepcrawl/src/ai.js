// AI tagging + summarisation through any OpenAI-compatible chat endpoint.
// Defaults target a local FreeLLMAPI router (model "auto").

export function createTagger({ llm }, fetchImpl = globalThis.fetch) {
  async function chat(messages) {
    const headers = { 'content-type': 'application/json' };
    if (llm.apiKey) headers.authorization = `Bearer ${llm.apiKey}`;
    const res = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: llm.model,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    return body.choices?.[0]?.message?.content ?? '';
  }

  return {
    enabled: llm.enabled,
    async analyse({ url, title, description, content, note }, existingTags = []) {
      const material = [
        url && `URL: ${url}`,
        title && `Title: ${title}`,
        description && `Description: ${description}`,
        note && `Note: ${note}`,
        content && `Content:\n${content.slice(0, llm.maxInputChars)}`,
      ]
        .filter(Boolean)
        .join('\n');

      const system = [
        'You are a librarian that organises a personal bookmark collection.',
        'Read the bookmark and reply with a JSON object: {"tags": string[], "summary": string}.',
        '- tags: 3 to 6 short, lowercase topical tags (1-3 words each). Prefer broad, reusable topics.',
        existingTags.length
          ? `- Reuse these existing tags when they fit: ${existingTags.slice(0, 200).join(', ')}.`
          : '',
        '- summary: a TL;DR of 2-3 plain sentences for someone who saved this link and will probably never open it: say what it is and give the single most useful takeaway, so they can decide in seconds whether it is worth reading.',
        `- Write the summary in ${llm.language}.`,
        'Return only the JSON object.',
      ]
        .filter(Boolean)
        .join('\n');

      const raw = await chat([
        { role: 'system', content: system },
        { role: 'user', content: material || '(empty bookmark)' },
      ]);
      return parseAiResponse(raw);
    },
  };
}

export function parseAiResponse(raw) {
  const text = String(raw || '').trim();
  const jsonText = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!jsonText) throw new Error('LLM did not return JSON');
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('LLM returned malformed JSON');
  }
  const tags = [...new Set(
    (Array.isArray(parsed.tags) ? parsed.tags : [])
      .map((t) => String(t).toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length <= 40),
  )].slice(0, 8);
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  return { tags, summary };
}

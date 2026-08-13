'use strict';

/**
 * Embedding provider behind an interface.
 *
 * Anthropic does not offer an embeddings endpoint - their docs point to Voyage
 * for Claude pairings. The interface matters more than the vendor: swapping to
 * a self-hosted model later should be a config change, not a migration, which
 * is why embed_model and embed_version are stored on every product row.
 */

const DIM = parseInt(process.env.EMBEDDING_DIM || '1024', 10);
const MODEL = process.env.EMBEDDING_MODEL || 'voyage-3';

async function voyageEmbed(texts, inputType) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: inputType,          // 'document' at sync, 'query' at request
      output_dimension: DIM
    })
  });
  if (!res.ok) throw new Error(`embed_failed_${res.status}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

const providers = { voyage: voyageEmbed };

async function embed(texts, inputType = 'document') {
  const fn = providers[process.env.EMBEDDING_PROVIDER || 'voyage'];
  if (!fn) throw new Error('unknown_embedding_provider');

  const out = [];
  // Batch to stay inside provider request limits.
  for (let i = 0; i < texts.length; i += 128) {
    out.push(...await fn(texts.slice(i, i + 128), inputType));
  }
  return out;
}

const toPgVector = (v) => `[${v.join(',')}]`;

module.exports = { embed, toPgVector, DIM, MODEL };

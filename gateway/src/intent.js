/**
 * Algivo gateway - intent parsing (v1, apparel)
 *
 * Turns a shopper's sentence into a structured query constrained to THIS
 * merchant's real attribute taxonomy. Never returns products. Never returns
 * prices. Returns the query that the storefront then executes itself.
 *
 * Model split:
 *   Haiku  - intent parse. Fast, cheap, called on every cache miss.
 *   Sonnet - narration and rerank. Streamed, non-blocking, tier-gated.
 *
 * The taxonomy block is large and completely static per site, so it sits in a
 * cached prompt prefix. That is the difference between this being affordable
 * and not.
 */

'use strict';

const crypto = require('crypto');

const MODEL_INTENT = 'claude-haiku-4-5-20251001';

/* ------------------------------------------------------------------ *
 * Tool definition - the schema the model MUST fill.
 * Tool use gives us guaranteed shape; no JSON repair, no retry loop.
 * ------------------------------------------------------------------ */

const INTENT_TOOL = {
  name: 'resolve_shopping_intent',
  description:
    'Resolve a shopper\'s natural-language request into a structured catalog ' +
    'query. Use only attribute names and values present in the provided ' +
    'taxonomy. Never invent attributes.',
  input_schema: {
    type: 'object',
    properties: {
      queryType: {
        type: 'string',
        enum: ['self', 'gift', 'occasion', 'replacement', 'browse'],
        description:
          'gift = buying for someone else. This changes page layout and ' +
          'messaging, not just filters.'
      },

      recipient: {
        type: 'object',
        description: 'Only when queryType is gift. Session-scoped, never persisted.',
        properties: {
          gender: { type: 'string', enum: ['mens', 'womens', 'unisex', 'unknown'] },
          ageBand: {
            type: 'string',
            enum: ['kids', 'teen', '18-24', '25-34', '35-49', '50+', 'unknown']
          }
        }
      },

      hardFilters: {
        type: 'object',
        description:
          'Attribute name -> array of values, ANDed. Every key must exist in ' +
          'the taxonomy and every value must appear under that key.',
        additionalProperties: { type: 'array', items: { type: 'string' } }
      },

      categories: {
        type: 'array',
        items: { type: 'string' },
        description: 'Category IDs from the taxonomy tree. Empty means no restriction.'
      },

      softSignals: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Free-text descriptors for semantic matching - fabric feel, styling, ' +
          'mood, use case. These do NOT filter; they rank. 3-8 items.'
      },

      excludes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Descriptors to rank down, e.g. "graphic print", "athleisure".'
      },

      price: {
        type: 'object',
        properties: {
          max: { type: 'number' },
          min: { type: 'number' }
        },
        description:
          'Bare numbers take the session currency. Never guess a currency ' +
          'from the query text.'
      },

      sizeStrategy: {
        type: 'string',
        enum: ['exact', 'infer', 'avoid_size_dependent'],
        description:
          'avoid_size_dependent when the shopper is buying for someone whose ' +
          'size they probably do not know. Boosts one-size and accessory ' +
          'categories, demotes fitted apparel.'
      },

      layout: {
        type: 'string',
        enum: ['grid', 'gift_buckets', 'outfit_sets'],
        description:
          'gift_buckets renders several small themed grids instead of one flat ' +
          'PLP. Choose it for open-ended gift browsing on a tight budget.'
      },

      clarify: {
        type: 'object',
        description:
          'Emit ONLY when a high-impact dimension is genuinely unresolved. ' +
          'Omit entirely when the query is already answerable.',
        properties: {
          dimension: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          blocking: {
            type: 'boolean',
            description:
              'true = ask before showing results. Reserve for queries that are ' +
              'genuinely 50/50. false = show results with chips above the grid.'
          }
        },
        required: ['dimension', 'question', 'options', 'blocking']
      },

      ignored: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Terms deliberately discarded. Populate this honestly - it is the ' +
          'audit trail shown to the merchant\'s legal and merchandising teams.'
      },

      narration: {
        type: 'string',
        description:
          'One short sentence shown above the grid. Never mention discarded ' +
          'personal attributes. Never state a price the storefront has not ' +
          'confirmed.'
      },

      confidence: { type: 'number', description: '0-1 on the overall resolution.' }
    },
    required: ['queryType', 'hardFilters', 'softSignals', 'sizeStrategy',
               'layout', 'ignored', 'narration', 'confidence']
  }
};

/* ------------------------------------------------------------------ *
 * Static rules. Cached prefix - identical for every tenant.
 * ------------------------------------------------------------------ */

const RULES = `You resolve apparel shopping requests into structured catalog queries.

CONSTRAINT
Use only attribute names and values that appear in the TAXONOMY block. If a
concept has no home in the taxonomy, put it in softSignals instead of inventing
an attribute. Never emit a value that is not listed.

AGE AND NOUN DISAMBIGUATION
An explicit age always overrides the descriptive noun.
  "boy, 18 years"   -> mens, ageBand 18-24. NOT the kids catalog.
  "girl, 22"        -> womens, ageBand 18-24.
  "my boy, 7"       -> kids.
  "boy" with no age -> ambiguous; clarify rather than guess.
This is the highest-frequency failure in this task. Check the age first.

ATTRIBUTES TO IGNORE
Discard these silently and list them in "ignored". Do not use them for filtering
or ranking, and never reference them in narration:
  - skin tone or complexion (fair, dark, wheatish, etc.)
  - body weight, body shape, or any appearance judgement
  - caste, religion, ethnicity, nationality
  - disability, health, or medical conditions
Height and build may be used ONLY as weak fit hints (e.g. longer inseam), never
as hard filters.

SIZE STRATEGY
  exact                 - shopper states a size, or is buying for themselves and
                          has a known size.
  infer                 - buying for themselves, size not stated.
  avoid_size_dependent  - buying for someone else with no size given. Boost
                          accessories, one-size items and gifting categories;
                          demote fitted apparel.

BUDGET
Treat a bare number as the session currency. A stated maximum is a hard filter,
but expect the caller to widen the band before retrieval. Never claim in
narration that items are under a budget - the storefront confirms final price.

CLARIFYING
Default to blocking:false. Showing results with refinement chips above the grid
gives the same information at zero friction, and chip clicks are a better signal
than an answered question.
Set blocking:true only when the query is genuinely under-determined AND guessing
wrong wastes the shopper's time - typically an unstated gender on a gift query
with no other signal.
Never ask more than one question.

LAYOUT
  grid          - default; a single ranked PLP.
  gift_buckets  - open-ended gift browsing, especially on a tight budget. Renders
                  several small themed grids.
  outfit_sets   - the shopper asked for a complete look rather than an item.

NARRATION
One sentence. Plain, warm, specific to what was understood. No sales language,
no emoji, no invented product claims.`;

/* ------------------------------------------------------------------ *
 * Prompt assembly
 * ------------------------------------------------------------------ */

function renderTaxonomy(profile) {
  const lines = ['TAXONOMY'];

  lines.push('\nAttributes:');
  for (const [key, def] of Object.entries(profile.refinements || {})) {
    lines.push(`  ${key} (${def.label}): ${def.values.join(', ')}`);
  }

  lines.push('\nCategories:');
  for (const node of flattenTree(profile.category_tree || [])) {
    lines.push(`  ${node.id}: ${node.path}`);
  }

  if (profile.price_bands && Object.keys(profile.price_bands).length) {
    lines.push(`\nTypical price bands: ${JSON.stringify(profile.price_bands)}`);
  }
  if (profile.has_giftcard) lines.push('\nThis catalog includes gift cards.');
  if (profile.has_giftwrap) lines.push('This catalog offers gift wrapping.');

  return lines.join('\n');
}

function flattenTree(nodes, prefix = '', out = []) {
  for (const n of nodes) {
    const path = prefix ? `${prefix} > ${n.name}` : n.name;
    out.push({ id: n.id, path });
    if (n.children) flattenTree(n.children, path, out);
  }
  return out;
}

/**
 * Two cache breakpoints:
 *   1. RULES        - identical across every tenant, so it is warm always.
 *   2. taxonomy     - per site+locale, warm after the first query of the window.
 * Only the shopper's sentence is uncached, which is a few dozen tokens.
 */
function buildSystem(profile) {
  return [
    { type: 'text', text: RULES, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: renderTaxonomy(profile), cache_control: { type: 'ephemeral' } }
  ];
}

/* ------------------------------------------------------------------ *
 * Normalisation - drives the cache key.
 * "office wear" from a thousand shoppers must produce one key.
 * ------------------------------------------------------------------ */

function normaliseQuery(raw) {
  return String(raw)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(i|me|my|please|want|need|show|find|looking|for|some|a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKey({ normalised, promptHash, rulesVersion }) {
  return crypto.createHash('sha256')
    .update(`${normalised}|${promptHash}|${rulesVersion}`)
    .digest('hex');
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function resolveIntent(anthropic, { query, profile, priorIntent, currency }) {
  const messages = [];

  // A refinement carries the prior intent so "something cheaper" resolves
  // against what came before instead of starting cold.
  if (priorIntent) {
    messages.push({
      role: 'user',
      content: `Previous resolution:\n${JSON.stringify(priorIntent)}`
    });
    messages.push({
      role: 'assistant',
      content: 'Understood. I will refine that rather than start over.'
    });
  }

  messages.push({
    role: 'user',
    content: `Session currency: ${currency}\nShopper says: "${query}"`
  });

  const res = await anthropic.messages.create({
    model: MODEL_INTENT,
    max_tokens: 1024,
    system: buildSystem(profile),
    tools: [INTENT_TOOL],
    tool_choice: { type: 'tool', name: 'resolve_shopping_intent' },
    messages
  });

  const block = res.content.find(
    (c) => c.type === 'tool_use' && c.name === 'resolve_shopping_intent'
  );
  if (!block) throw new Error('intent_parse_failed');

  return {
    intent: validate(block.input, profile),
    usage: res.usage
  };
}

/**
 * Belt and braces. tool_choice guarantees shape, not semantics - a model can
 * still emit an attribute value that has drifted out of the catalog since the
 * prompt was cached. Silently drop anything unknown rather than returning an
 * empty grid.
 */
function validate(intent, profile) {
  const refs = profile.refinements || {};
  const clean = {};

  for (const [key, values] of Object.entries(intent.hardFilters || {})) {
    if (!refs[key]) continue;
    const allowed = new Set(refs[key].values);
    const kept = (values || []).filter((v) => allowed.has(v));
    if (kept.length) clean[key] = kept;
  }
  intent.hardFilters = clean;

  const validCats = new Set(flattenTree(profile.category_tree || []).map((n) => n.id));
  intent.categories = (intent.categories || []).filter((c) => validCats.has(c));

  if (intent.clarify && !intent.clarify.options?.length) delete intent.clarify;

  return intent;
}

module.exports = {
  INTENT_TOOL,
  RULES,
  MODEL_INTENT,
  resolveIntent,
  normaliseQuery,
  cacheKey,
  buildSystem,
  renderTaxonomy,
  validate
};

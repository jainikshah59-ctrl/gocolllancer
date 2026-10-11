/* CleoAI facade for gocolllancer — replicates the collancerlatest CleoPanel answer
 * pipeline exactly (brainAnswer / creatorDatabaseAnswer), with the fail-closed
 * scope guard running BEFORE the pool and the deterministic brain.
 *
 * Usage (after this module loads): window.CleoAI.ask(question, { isCreator, context })
 *   context: { user, creators, bookings, payouts, verification, convo, live, isPro }
 * Returns: Promise<{ answer, creators[], actions[], confidence }>
 */
import { answerQuery } from './engine.js';
import { askCreatorAI } from './creatorAi.js';
import { findKnowledge } from './cleoKnowledgeBase.js';
import { poolAnswer, isPoolableQuery, mentionsCollancer } from './llmPool.js';
import { checkScope, scopeRefusal, socialReply } from './scopeGuard.js';
import { QA_ENTRIES, KB_TOPICS } from './knowledge.js';

const CREATOR_FALLBACK = 'I can help with brand collaborations, paid and barter deals, UGC, pitching, rates, deliverables, usage rights, revisions, invoices, payments, and campaign briefs. Try asking your question with the specific topic or situation, and I will match it against the creator knowledge database.';

function guard(q, isCreator, convo) {
  try {
    const sc = checkScope(q, isCreator, convo || null);
    if (!sc.inScope) return { blocked: true, answer: scopeRefusal(isCreator) };
    if (sc.kind === 'social') return { blocked: true, answer: socialReply(q, isCreator), confidence: 0.9 };
  } catch { /* guard failure -> fail open to brain, never crash */ }
  return { blocked: false };
}

/* Creator side: strictly local/database-backed. No external AI provider. */
async function creatorAnswer(q, context = {}) {
  q = String(q || '').trim();
  if (!q) return { answer: '', creators: [], actions: [], confidence: 0 };
  const g = guard(q, true, context.convo);
  if (g.blocked) return { answer: g.answer, creators: [], actions: [], confidence: g.confidence || 1 };

  const account = {
    creator: context.user || {},
    bookings: context.bookings || [],
    payouts: context.payouts || [],
    verification: context.verification || null,
  };
  try {
    const r = await askCreatorAI(q, account);
    if (r && r.answer) return { answer: r.answer, creators: [], actions: r.actions || [], confidence: 0.8 };
  } catch { /* fall through to knowledge retrieval */ }
  try {
    const m = findKnowledge(q, 'creator');
    if (m && m.entry && m.entry.answer) {
      return { answer: m.entry.answer, creators: [], actions: [], confidence: m.confidence || 0.7 };
    }
  } catch { /* keep deterministic fallback below */ }
  return { answer: CREATOR_FALLBACK, creators: [], actions: [], confidence: 0.3 };
}

/* Brand side: Collancer-name questions -> deterministic engine; ordinary
 * questions -> keyless LLM pool; discovery/data queries stay on real records. */
async function brandAnswer(q, context = {}) {
  q = String(q || '').trim();
  if (!q) return { answer: '', creators: [], actions: [], confidence: 0 };
  const g = guard(q, false, context.convo);
  if (g.blocked) return { answer: g.answer, creators: [], actions: [], confidence: g.confidence || 1 };

  const ctx = {
    creators: context.creators || [],
    user: context.user || null,
    role: 'business',
    isPro: !!context.isPro,
    live: context.live !== false,
    knowledge: QA_ENTRIES,
    kbTopics: KB_TOPICS,
    convo: context.convo || null,
  };
  if (mentionsCollancer(q)) return await answerQuery(q, ctx);
  if (isPoolableQuery(q, ctx.convo)) {
    let pooled = null;
    try { pooled = await poolAnswer(q, false); } catch { /* provider chain exhausted */ }
    if (pooled && pooled.text) return { answer: pooled.text, creators: [], actions: [], confidence: 0.78 };
    return {
      answer: 'The AI service is temporarily unavailable. Please try again in a moment.',
      creators: [], actions: [], confidence: 0,
    };
  }
  return await answerQuery(q, ctx);
}

window.CleoAI = {
  ask: (q, opts = {}) => (opts && opts.isCreator ? creatorAnswer(q, opts.context) : brandAnswer(q, opts.context)),
  creatorAnswer,
  brandAnswer,
};

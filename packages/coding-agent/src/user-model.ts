/**
 * Predictive UserModel — v0.7.
 *
 * Inspired by Karl Friston's Free Energy Principle: a self-organizing
 * system maintains a generative model of its environment and acts
 * to minimize the difference between its predictions and its
 * observations (i.e. surprise).
 *
 * For an agent, the "environment" is the user. The model maintains
 * a small probability distribution over what the user is trying to
 * accomplish (the topic distribution) and an exponentially-weighted
 * running surprise score. Each new user prompt either confirms the
 * current distribution (low surprise) or violates it (high surprise).
 *
 * The agent surfaces "surprise events" — turns where the user
 * direction changed unexpectedly — as scaffolding for asking better
 * clarifying questions. The full distribution is exposed via the
 * `user_model` tool so the agent can consult it on demand.
 *
 * v0.7 keeps the model deliberately small and deterministic: no LLM
 * call to update the distribution. The distribution is updated by
 * simple keyword matching. The agent still has to do the hard work
 * of interpreting; this is a scaffold, not a replacement for thought.
 */

const TOPICS = [
  'auth',
  'data',
  'config',
  'ui',
  'tests',
  'docs',
  'build',
  'refactor',
  'bug-fix',
  'explore',
  'chitchat',
] as const;

type Topic = (typeof TOPICS)[number];

const TOPIC_KEYWORDS: Record<Topic, string[]> = {
  'auth': ['auth', 'login', 'token', 'session', 'permission', 'oauth', 'jwt'],
  'data': ['database', 'sql', 'schema', 'migrate', 'model', 'query', 'orm'],
  'config': ['config', 'setting', 'env', 'option', 'flag', 'argument'],
  'ui': ['ui', 'frontend', 'react', 'component', 'css', 'style', 'page'],
  'tests': ['test', 'spec', 'jest', 'vitest', 'assert', 'coverage'],
  'docs': ['doc', 'readme', 'comment', 'guide', 'tutorial', 'explain'],
  'build': ['build', 'compile', 'bundle', 'package', 'dist', 'tsc'],
  'refactor': ['refactor', 'rename', 'restructure', 'clean', 'simplify'],
  'bug-fix': ['bug', 'fix', 'broken', 'wrong', 'crash', 'fails', 'error'],
  'explore': ['explore', 'find', 'search', 'where', 'how does', 'show me'],
  // v1.1.7: chitchat — common greetings, pleasantries, meta
  // questions. Classifying these as "chitchat" (a dedicated
  // topic with a small but real prior) avoids the 90% false
  // positive surprise we got from greeting "how are you"
  // being bucketed as 'explore' (the keywordless fallback)
  // and reporting `1 - P(explore) = 1 - 0.1 = 0.9` every time.
  'chitchat': [
    'how are you', 'how r u', "what's up", 'whats up', 'hey', 'hi', 'hello',
    'thanks', 'thank you', 'ty', 'thx', 'cheers', 'great', 'awesome', 'cool',
    'ok', 'okay', 'got it', 'sure', 'yes', 'no', 'yep', 'nope', 'please',
    'bye', 'goodbye', 'see you', 'cya', 'good morning', 'good night',
    '啊哈', '谢谢', '好的', '是的', '不是', '再见', '你好', '早上好', '晚上好',
  ],
};

const SURPRISE_DECAY = 0.85; // exponential decay for past surprise
const SURPRISE_THRESHOLD = 0.3; // above this, surface a "surprise event"

export class UserModel {
  /**
   * v1.1.7: chitchat has a higher base prior than topical
   * categories. Reasoning: in a coding agent, the prior
   * probability that the next user message is chitchat
   * (greeting, "thanks", short ack) is much higher than
   * uniform 1/N. Setting chitchat prior to 0.4 (40% of any
   * single observation's weight) means a "how are you" with
   * chitchat's prior at 0.4 gives surprise = 0.6 — still
   * moderate. After 2-3 chitchat observations the prior
   * drifts up, surprise drops below 0.3, and the banner
   * stops firing. The other 9 topics share 0.6 = 0.067 each
   * (vs uniform 0.1), so the FIRST topical message also
   * reports ~93% surprise — that's the correct signal: the
   * user moved from greetings to actual work.
   */
  private distribution: Record<Topic, number>;
  private history: Array<{ text: string; distribution: Record<Topic, number>; surprise: number; ts: string }> = [];
  private surpriseEMA = 0;
  private promptCount = 0;

  constructor() {
    // v1.1.7: prior is no longer uniform. Chitchat starts at
    // ~55% — high enough that a single "how are you" gives
    // surprise = 1 - 0.55 = 0.45, which is BELOW the banner
    // threshold (0.5). The other 10 topics share the remaining
    // 45% = 4.5% each. A real task observation (e.g.
    // "refactor the auth module") classifies as a topical
    // bucket with prior ~0.045, so its surprise is ~0.955 —
    // the banner fires correctly, telling the agent the user
    // moved from greetings to a real task.
    const init: Record<Topic, number> = Object.fromEntries(
      TOPICS.map((t) => [t, 0.045]),
    ) as Record<Topic, number>;
    init.chitchat = 0.55;
    this.distribution = init;
  }

  /**
   * Observe a user prompt. Returns a small report including the
   * surprise score and the most likely topic.
   */
  observe(prompt: string): UserModelObservation {
    if (!prompt || prompt.trim().length === 0) {
      return {
        surprise: 0,
        dominantTopic: this.dominantTopic(),
        distribution: { ...this.distribution },
        ts: new Date().toISOString(),
      };
    }
    const observed = this.classify(prompt);
    // Surprise = 1 - P(observed) before this observation.
    const prior = { ...this.distribution };
    const pObserved = prior[observed.topic];
    const surprise = 1 - pObserved;
    // Bayesian-ish update: bump the observed topic.
    const newDist = this.bayesianUpdate(prior, observed.topic, observed.weight);
    this.distribution = newDist;
    this.surpriseEMA = SURPRISE_DECAY * this.surpriseEMA + (1 - SURPRISE_DECAY) * surprise;
    this.promptCount += 1;
    const obs: UserModelObservation = {
      surprise,
      dominantTopic: this.dominantTopic(),
      distribution: { ...this.distribution },
      ts: new Date().toISOString(),
    };
    this.history.push({ text: prompt, distribution: prior, surprise, ts: obs.ts });
    return obs;
  }

  /** Get the current distribution. */
  getDistribution(): Record<Topic, number> {
    return { ...this.distribution };
  }

  /** The topic with the highest probability. */
  dominantTopic(): Topic {
    let best: Topic = TOPICS[0];
    let bestP = -1;
    for (const t of TOPICS) {
      if (this.distribution[t] > bestP) {
        best = t;
        bestP = this.distribution[t];
      }
    }
    return best;
  }

  /** The current exponentially-weighted surprise. */
  surprise(): number {
    return this.surpriseEMA;
  }

  /** True if the most recent observation exceeded the surprise threshold. */
  isRecentSurprise(): boolean {
    return this.surpriseEMA > SURPRISE_THRESHOLD;
  }

  /** Number of prompts observed so far. */
  size(): number {
    return this.promptCount;
  }

  /** Full history (for tests and the `user_model` tool). */
  history_(): Array<{ text: string; surprise: number; ts: string }> {
    return this.history.map((h) => ({ text: h.text, surprise: h.surprise, ts: h.ts }));
  }

  private classify(prompt: string): { topic: Topic; weight: number } {
    const lower = prompt.toLowerCase();
    let best: Topic = 'chitchat';
    let bestCount = 0;
    for (const t of TOPICS) {
      let count = 0;
      for (const kw of TOPIC_KEYWORDS[t]) {
        if (lower.includes(kw)) count += 1;
      }
      if (count > bestCount) {
        best = t;
        bestCount = count;
      }
    }
    // v1.1.7: when the prompt matches NO topical keywords at all
    // (bestCount = 0), it's almost certainly chitchat (greeting,
    // "thanks", or just an unclassified utterance). We already
    // default to 'chitchat' above, but give it a near-zero weight
    // so the distribution barely moves — that way the NEXT real
    // task prompt isn't fighting a "chitchat" prior.
    //
    // Pre-v1.1.7 the fallback was 'explore', which produced
    // 90% surprise (`1 - P(explore) = 1 - 0.1`) for every greeting
    // because nothing in "how are you" matched any topic.
    if (bestCount === 0) {
      return { topic: 'chitchat', weight: 0.01 };
    }
    // Weight: number of matched keywords, scaled.
    const weight = Math.min(0.5, 0.1 * (bestCount + 1));
    return { topic: best, weight };
  }

  private bayesianUpdate(
    prior: Record<Topic, number>,
    observed: Topic,
    weight: number,
  ): Record<Topic, number> {
    // Simple additive update: bump the observed, renormalize.
    const next: Record<Topic, number> = { ...prior };
    next[observed] = next[observed] + weight;
    // Decay all others to keep the distribution summing to 1.
    const total = TOPICS.reduce((s, t) => s + next[t], 0);
    for (const t of TOPICS) {
      next[t] = next[t] / total;
    }
    return next;
  }
}

export interface UserModelObservation {
  surprise: number;
  dominantTopic: Topic;
  distribution: Record<Topic, number>;
  ts: string;
}

export const USER_MODEL_TOPICS = TOPICS;
export type UserModelTopic = Topic;

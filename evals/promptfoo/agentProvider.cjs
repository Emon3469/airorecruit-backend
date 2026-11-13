// Promptfoo custom provider: runs the real AiroRecruit agent (rails + tools + proposal layer)
// on a Docker-free stack (in-memory MongoDB, in-memory queues executing the real workers).
// Uses the real LLM when LLM_API_KEY is set, otherwise the deterministic offline provider.
const { register } = require('tsx/cjs/api');
register();
const { runAgentProbe } = require('./probe.ts');

class AiroRecruitAgentProvider {
  constructor(options = {}) {
    this.providerId = options.id || 'airorecruit-agent';
  }
  id() {
    return this.providerId;
  }
  async callApi(prompt) {
    try {
      const output = await runAgentProbe(prompt);
      return { output };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  }
}

module.exports = AiroRecruitAgentProvider;

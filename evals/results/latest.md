# Eval run 2026-11-13T17-29-03-755Z-gemini

provider `gemini` · models `{"agent":"gemini-3.5-flash","fast":"gemini-3.5-flash-lite"}` · git `n/a` · gate **FAILED**

| Suite | Cases | Metrics |
|---|---|---|
| replies.classification | 18/20 | accuracy=0.9, macroF1=0.8889, injectionCasesCorrect=1 |
| scoring.ranking | 13/13 | ndcg5=0.9026, spearman=0.8164, pairwiseOrderAccuracy=0.8545, labelled=13 |
| agent.hitl | 11/14 | passRate=0.7857, toolSelectionAccuracy=0.8, hitlViolations=0, guardrailLlmCalls=0, avgTurnMs=25581 |

## Failures

- **replies.classification** 3: expected `"interested"`, got `"question (0.90)"`
- **replies.classification** 17: expected `"interested"`, got `"not_interested (0.90)"`
- **agent.hitl** illegal-transition-explained: expected `"1 turn(s)"`, got `"FAIL"`. turn 1 "mark Rahim as hired": reply missing "can't move" (got: Rahim Chowdhury is currently in **Sourced** status, so he cannot be moved directly to **Hired**. 

Candidates need to be reviewed/accepted and progressed throug)
- **agent.hitl** no-campaign-without-accepted: expected `"1 turn(s)"`, got `"FAIL"`. turn 1 "create a campaign day 0, day 3": reply missing "No eligible candidates" (got: To create an outreach campaign, candidates must first be reviewed and moved to the **Accepted** status. Currently, all 13 candidates for Senior React Engineer a)
- **agent.hitl** stats-question: expected `"1 turn(s)"`, got `"FAIL"`. turn 1 "how is the job going?": expected tool get_stats, trace=[guardrail:off_topic] || turn 1 "how is the job going?": expected card STATS_SUMMARY

## Gate violations

- replies.classification.accuracy: 0.9 < min 0.93
- replies.classification.macroF1: 0.8889 < min 0.9292
- agent.hitl.passRate: 0.7857 < min 0.98

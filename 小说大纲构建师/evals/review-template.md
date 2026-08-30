# 独立盲评记录

每个评审人对同一 `case_id` 单独提交一个 JSON 文件。文件中不得出现生成模型、生成提示词、版本来源等信息；评审只看大纲资产及题材标签。

```json
{
  "review_id": "REV-001",
  "case_id": "CASE-001",
  "reviewer_id": "R-001",
  "genre": "mystery",
  "scores": {
    "causal_pressure": 0,
    "character_necessity": 0,
    "opponent_agency": 0,
    "genre_delivery": 0,
    "reveal_payoff": 0,
    "continue_pull": 0
  },
  "would_continue": true,
  "evidence": ["引用具体章节/场景，不写只有形容词的评价"]
}
```

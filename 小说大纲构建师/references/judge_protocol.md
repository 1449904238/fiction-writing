# 语义评审协议（judge protocol）

机检门禁只处理无歧义的结构事实；质量判断交给本协议定义的语义评审。本协议的唯一目标是：**让每一次质量结论都可被机器核验其证据真实性，杜绝印象分和幻觉引用。**

## 角色与输入

评审（AI 或人类）拿到三样东西：

1. `01_大纲数据.json`——被评大纲本体；
2. `03_审计回执.json`——机检结果。`severity=warn` 的告警（题材负模式、无代价推进嫌疑等）在此路由给评审抽查；
3. `evals/quality_rubric.json`——六维评分标尺（因果压力/人物不可替代性/对手主动性/题材兑现/伏笔与反转/继续阅读欲）。

## 评审任务

1. **裁决机检告警**：对回执中每条 warn，给出 `confirmed`（真问题，需要修改）或 `false_positive`（机检误报，说明为什么）。
2. **维度评分**：按 quality_rubric.json 的六维，以卷或全书为对象打 0-4 分。
3. **独立发现**：机检漏掉的质量问题（`fail` 判定），同样必须锚定证据。

## 判断文件格式

评审结论写入 `04_语义评审.json`：

```json
{
  "judgment_version": "1.0",
  "outline": "01_大纲数据.json",
  "receipt": "03_审计回执.json",
  "reviewer": "agent-semantic-review",
  "verdicts": [
    {
      "target": "MYST-A1",
      "scope": "CH-0004",
      "verdict": "confirmed",
      "evidence": [
        {"anchor": "CH-0004#foreshadowing_ops[0].summary", "claim": "本章无伏笔操作且证据链轴推进为空"}
      ],
      "note": "连续第3章无证据链推进，悬念供给不足"
    },
    {
      "scope": "V-01",
      "dimension": "opponent_agency",
      "verdict": "pass",
      "score": 3,
      "evidence": [
        {"anchor": "V-01#opposition", "claim": "对手目标与手段具体，且随主角行动升级"}
      ]
    }
  ]
}
```

字段规则：

| 字段 | 必填 | 说明 |
|---|---|---|
| `judgment_version` | 是 | 固定 `1.0` |
| `outline` | 是 | 被评大纲路径 |
| `receipt` | 否 | 关联的审计回执路径；提供 `target` 时必填 |
| `reviewer` | 是 | `agent-semantic-review` / `human` / 自定义标识 |
| `verdicts[]` | 是 | 至少 1 条 |
| `verdicts[].target` | 否 | 机检告警的规则 ID（如 `MYST-A1`）；提供时必须真实存在于回执告警中 |
| `verdicts[].scope` | 是 | 判断对象：章节 ID（`CH-0004`）/ 卷 ID（`V-01`）/ `outline`（全书） |
| `verdicts[].dimension` | 否 | quality_rubric.json 的维度 ID；打分时必填 |
| `verdicts[].verdict` | 是 | `confirmed` / `false_positive` / `pass` / `fail` |
| `verdicts[].score` | 否 | 0-4 整数；提供 `dimension` 时必填 |
| `verdicts[].evidence[]` | 是 | 至少 1 条；每条含 `anchor` 与 `claim` |
| `verdicts[].note` | 否 | 结论说明 |

## 证据锚定规则（反 Goodhart 的核心）

1. **anchor 语法**：`{对象ID}#{字段路径}`，如 `CH-0002#gocs[0].state_change`、`V-01#cost`。对象 ID 必须是真实存在的章节或卷；字段路径必须能在大纲 JSON 中解析出非空值。
2. **每个结论至少一条 anchor**。没有 anchor 的结论在 `verify_judgment.py` 中直接判 INVALID——这不是形式主义，而是防止评审用“感觉节奏偏慢”这类无法复核的话术替代分析。
3. **claim 写证据支持什么**，不重复 anchor 内容。机器核验 anchor 真实性；claim 的语义合理性由人工复审或更高层评审抽查。
4. **禁止锚定不存在的东西**：引用被删除的章节、编造的字段路径，都会被机检拒绝。

## 机检流程

```bash
python scripts/verify_judgment.py 04_语义评审.json
```

核验通过输出 `VERIFIED JUDGMENT`；任何结构错误、幻觉 anchor、虚构 target、越界 score 都输出 `INVALID JUDGMENT` 并列出问题。核验通过不代表结论正确，只代表**证据真实存在**——语义正确性仍需人工或上级评审把关。

## 与门禁的关系

- 机检 `block` → 大纲直接 INVALID，不进入评审；
- 机检 `warn` → 进回执，由本协议裁决；
- 评审 `confirmed` + `hard_fails` 命中 → 建议打回重写对应章节；
- 评审 `fail`（独立发现）→ 按 anchor 定位修改点；
- 评审 `false_positive` → 记录在案，用于修订 genre_contracts.json 的检测器模式（连续多次误报的模式应该被收紧或删除）。

评审结论不改变机检结果；两条线独立记录，最终由作者决策。

# 大纲构建执行率评测规程

本评测只报告可复核的执行情况，不把“精彩”伪装成确定性指标。

## 分项

- `R_input`：输入是一份设定文档（`_设定架构.md` 样式）或设定包；角色/地点/势力/规则/资源引用可追溯，“保留/新增推导/未决项”区分清楚。使用设定包时版本一致，独立设定文档时 `source_trace` 覆盖来源与推导。
- `R_schema`：`01_大纲数据.json` 通过 `scripts/validate_outline.py` 的结构检查。
- `R_semantic`：卷归属、章节连续性、终局 ID、伏笔生命周期、线权重和交汇语义通过。
- `R_handoff`：`scripts/project_outline.py` 成功生成 JSON/Markdown，且每章拥有情绪、线归属、交汇、分支、伏笔和未解决拉力字段。
- `R_gate`：唯一放行命令成功生成 `03_审计回执.json` 和 `03_连续性账本.json`。
- `R_quality`：按 `evals/quality_rubric.json` 做独立盲评，检查因果、人物选择、对手主动性、题材兑现、反转证据和继续阅读欲。

主要执行指标是 `E2E_pass_rate = 所有硬门禁通过的样本数 / 总样本数`。它比把几个相关比例相乘更适合描述执行稳定性。质量单独报告为 0-100 分，并按题材拆分；不要用结构通过率替代精彩度。

若仍需保留 `R_total`，只能把它作为单样本硬门禁乘积的兼容字段，不作为跨样本主指标。

没有盲评结果时，`R_quality` 和 `R_total` 必须标记为 `unmeasured`；不能用脚本通过率替代故事质量。

## 样本设计

正式评测建议使用 8 个题材 × 3 种结构 × 2 种输入完整度 × 3 次重复，共 144 个样本。首轮可用 `examples/three_chapter_outline.json` 做烟雾测试，再逐步扩展到悬疑、言情、成长/战斗、职场/现实、历史/架空、都市、科幻和混合题材。

## 对抗回归

`python evals/run_evals.py --self-test` 一键运行四个 fixture 套件加跨批正例链路，用于改动校验器/契约后的回归验证：

- `fixtures/adversarial/`：题材契约 block 级负例（MYST/ROMA/PROG/FANT、词表、休整章、evidence）、warn 级只告警不拒绝、1.2 旧大纲兼容回归。
- `fixtures/commercial/`：商业层机检（evidence_source 文件存在性、高拉力钩子、hook_type 枚举）。
- `fixtures/judgment/`：语义评审判断文件的证据锚点核验（幻觉引用、越界分数被拒）。
- `fixtures/cross_batch/`：finalize --previous 跨批负例拦截与批 2 正例链路。

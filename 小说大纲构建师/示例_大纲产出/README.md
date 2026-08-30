# 示例_大纲产出 —— 小说大纲构建师 产出对照包

本目录是「小说大纲构建师」的**产出示例**，展示一套**只产出大纲**的交付长什么样，供对照产出结构、理解字段含义与校验产物。本 skill 是独立的：它把设定转化为**大纲**并给出质量凭证，不产出细纲交接或其他下游内容。命名对齐「小说设定架构师」的 `示例_设定包/` 做法——一个自包含、可运行、可对照的包，而非散落样例。

## 组成（唯一交付物 = 大纲）

| 文件 | 作用 | 归属 |
|---|---|---|
| `00_大纲简报.md` | **作者可读摘要**：方向、读者承诺、故事引擎、分卷因果、人物弧、未决项；不新增事实，只转述 `01` | 大纲（人读） |
| `01_大纲数据.json` | **大纲本体**（contract 1.3 / outline_scope=batch），规范且可执行，是本 skill 的核心交付 | 大纲（机读） |
| `03_审计回执.json` | **质量凭证**：contract 版本、章数、各门禁 `passed`/`skipped`、`warnings`、派生物 sha256；无 `status=passed` 不得交付 | 质量凭证 |
| `03_连续性账本.json` | 连续性派生保障：时间/地点/存活状态/资源/不可逆事实，供跨批核验与保证一致性 | 内部保障 |
| `README.md` | 本说明 | 文档 |

> **不包含 `02_细纲交接`**：细纲交接是给**下游细纲构建/扩写**阶段的消费格式，不属于本 skill 的产出。本 skill 只交付大纲本体与质量凭证/连续性保障。

派生文件（`03_*/`）**不得手工修改成另一套事实**，只能在重跑 `finalize_outline.py` 后由脚本重写。

## 题材与输入

本示例是**悬疑（mystery）题材、首卷 3 章批次**，输入是一部完整的设定包：

- 输入设定包：`小说设定架构师/示例_设定包/`（《雾港档案》，四件套 + `.work/core_gate.json`）
- 题材推进轴：证据链 / 嫌疑模型 / 风险等级
- 读者承诺：推理建立在可验证物证上，每次查证既得一条证据又付出代价

消费设定包时，本示例示范了「忠实传递」的字段映射（详见 `references/大纲数据契约.md` 的「设定包 → 大纲 字段映射」表）：

- `genre_module.primary.data.clue_ledger`（clue-1/2/3）→ `foreshadowing`（FS-001/002/003 通过 `source_clue` 绑定）
- `02` 的 `narrative_guardrails.avoid_moves/required_moves` → `genre_profile.avoid_moves/must_deliver`
- `.work/core_gate.json` → `direction_gate`
- `02` 的 `scene_test` → 每章 `gocs` / `state_delta`

## 如何校验 / 重放

```bash
# 结构 + 设定包映射机检（透传设定包目录，触发 block/warn 断言）
python scripts/validate_outline.py 示例_大纲产出\01_大纲数据.json --setting-package 小说设定架构师\示例_设定包

# 重新生成派生物（质量凭证 + 连续性账本），--skip-handoff 表示只产出大纲、不投影细纲交接
python scripts/finalize_outline.py 示例_大纲产出\01_大纲数据.json --output-dir 示例_大纲产出 --skip-handoff
```

未提供 `--setting-package` 时，仍可做结构校验，但跳过设定包映射断言（`source_clue` / 约束传递检查）。

## 对照要点

- **结构门禁**：`01_大纲数据.json` 通过 `validator`（题材词表、伏笔生命周期、实体账本、商业层等高确定性规则）；回执中 `gates.validator=passed`、`warnings=[]`。
- **内容门禁**：机检只裁决无歧义结构是否达标；故事质量（因果压力、人物不可替代性、对手主动性、题材兑现、反转证据、继续阅读欲）按 `evals/quality_rubric.json` 单独盲评。
- **输入兼容**：本示例是可复演的**输入形状示范**，不是绑定题材。对任何同形状的设定包都可成立；题材、人物、规则全部取自实际输入，不因示例默认复用《雾港档案》的设定。

本目录是发布时的**样板产出**；`examples/` 下属测试基底与 `evals/` 对抗回归，两者职责不同、互不干扰。
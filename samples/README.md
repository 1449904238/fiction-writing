# 产出样本验证体系

> 本目录用于存放03→04→05三阶段的标准产出样本，作为规则有效性的验证基线和AI对标参考。
> V4.0 升级：增加回归测试流程、规则开关清单、10维评分量规。

## 目录结构

```
samples/
├── README.md                    — 本文件
├── baseline/                    — 基线样本（不随规则迭代修改）
│   ├── ch01_战斗章/
│   │   ├── ch01_细纲.md          — 输入：细纲+衔接包
│   │   ├── ch01_03a_初稿.md      — 03a扩写产出
│   │   ├── ch01_03b_质检.md      — 03b质检报告
│   │   ├── ch01_04_精修.md       — 04精修产出
│   │   ├── ch01_05_终稿.md       — 05去AI味产出
│   │   ├── ch01_检测报告.md      — 确定性脚本检测报告
│   │   ├── ch01_评分.json        — 10维评分量规
│   │   └── ch01_diff对比.md      — 三阶段逐段对比
│   ├── ch02_日常章/
│   └── ch03_情绪章/
├── regression/                  — 回归测试产出（每次迭代后生成）
│   ├── YYYYMMDD_ch01/
│   ├── YYYYMMDD_ch02/
│   └── YYYYMMDD_ch03/
└── config/
    └── rules.json               — 规则开关清单
```

## 样本用途

1. **验证规则有效性**：对比03a初稿→04精修→05终稿的质量提升，验证规则是否有效
2. **AI对标参考**：03a扩写时参考样本中的写法，05去AI味时参考样本中的改法
3. **回归测试基线**：规则迭代后，用同样输入重新生成，对比是否产生退化

## 样本选择标准

- 选择涵盖多种场景类型的章节：
  - **战斗章**：验证动作描写、节奏控制、战力一致性
  - **日常章**：验证对话风格、角色辨识度、信息密度
  - **情绪章**：验证情绪工程、用户锚点融入、质感深化
- 选择有典型AI味问题的初稿（验证05去AI味效果）
- 样本一旦建立，不随规则迭代修改（作为历史基线）

## 回归测试流程

### 触发条件
每次以下变更后执行回归测试：
- skill 文件修改（03a/03b/04/05/02 任何规则变更）
- 新增/删除/修改确定性脚本
- references 素材库变更

### 执行步骤

1. **使用 baseline/ 中的同样 3 章细纲作为输入**
2. **完整执行 03a→03b→04→05 流程**（或对应的新流程）
3. **保存产出到 `regression/YYYYMMDD_chXX/`**
4. **运行确定性脚本检测**，保存报告
5. **对比基线，检查以下项**：

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| 字数范围 | check-ai-patterns.js | 3500-4500 字 |
| 对话占比 | check-ai-patterns.js | ≤60% |
| Burstiness | check-ai-patterns.js | >0.35 |
| 标点限额 | check-ai-patterns.js | 省略号≤5/破折号≤4/感叹号≤15 |
| AI味模式 | check-ai-patterns.js | 无新增AI味模式 |
| 跨章重复 | extract-used-patterns.js | 无新增跨章重复 |
| 角色一致性 | check-consistency.js | 0矛盾 |
| 节奏波形 | check-rhythm.js | 无新增塌陷 |
| 用户审美 | 人工判断 | ≥基线评分 |
| 信息密度 | 人工+脚本 | 无下降 |

6. **如果任一项不通过，标记为"回归退化"**，需要修复后重新测试

## 10维评分量规

每章产出后由三个角色分别打分（1-5分）：

| 维度 | 评分方 | 说明 |
|------|--------|------|
| 目标清晰 | quality-checker Agent | 本章核心冲突是否明确 |
| 受众具体 | 用户 | 是否符合目标读者画像 |
| 具体性 | 脚本+Agent | 细节是否足够具体 |
| 洞见密度 | quality-checker Agent | 每场景信息增量 |
| 结构聚焦 | 脚本检测 | 是否有冗余场景 |
| 声音可信 | 用户 | 角色对话是否有辨识度 |
| 节奏控制 | burstiness脚本 | 句长变化是否自然 |
| 情绪到达 | 用户 | 是否被打动 |
| AI味 | 脚本+Agent | AI痕迹是否明显 |
| 记忆度 | 用户 | 是否有令人印象深刻的场景 |

评分格式（JSON）：
```json
{
  "chapter": "ch01",
  "date": "2026-07-15",
  "scores": {
    "目标清晰": { "score": 4, "scorer": "quality-checker" },
    "受众具体": { "score": 4, "scorer": "user" },
    "具体性": { "score": 3, "scorer": "script+agent" },
    "洞见密度": { "score": 3, "scorer": "quality-checker" },
    "结构聚焦": { "score": 4, "scorer": "script" },
    "声音可信": { "score": 3, "scorer": "user" },
    "节奏控制": { "score": 4, "scorer": "script" },
    "情绪到达": { "score": 3, "scorer": "user" },
    "AI味": { "score": 4, "scorer": "script+agent" },
    "记忆度": { "score": 3, "scorer": "user" }
  },
  "total": 35,
  "average": 3.5
}
```

## 规则开关清单

位于 `config/rules.json`，允许逐条启用/禁用规则：

```json
{
  "version": "V4.0",
  "rules": [
    {"id": "R001", "name": "否定排比拦截", "enabled": true, "step": "05", "gate": 1},
    {"id": "R002", "name": "破折号复读检测", "enabled": true, "step": "05", "gate": 2},
    {"id": "R003", "name": "比喻质量三重门", "enabled": true, "step": "04"},
    {"id": "R004", "name": "情绪锚点密度检查", "enabled": true, "step": "03b"},
    {"id": "R005", "name": "解释腔检测", "enabled": true, "step": "05", "gate": 6},
    {"id": "R006", "name": "套话检测", "enabled": true, "step": "05", "gate": 10},
    {"id": "R007", "name": "跨章句式去重", "enabled": true, "step": "03a", "script": "extract-used-patterns.js"},
    {"id": "R008", "name": "衔接包自动压缩", "enabled": true, "step": "02", "script": "compress-handoff.js"},
    {"id": "R009", "name": "burstiness检测", "enabled": true, "step": "03b", "script": "check-ai-patterns.js"},
    {"id": "R010", "name": "情绪词密度", "enabled": true, "step": "03b", "script": "check-emotion-density.js"}
  ]
}
```

## 当前状态

- **baseline/**: 待填充 — 需要实际执行一次完整流程生成首批3章样本
- **regression/**: 待首次规则迭代后生成
- **config/rules.json**: 已建立初始版本

### 生成首批基线样本的步骤

1. 完成项目初始化（00.5）和设定架构（00）
2. 生成前3章细纲（02），选择不同场景类型
3. 对每章执行 03a→03b→04→05 完整流程
4. 每阶段产出保存到 `baseline/chXX_场景类型/`
5. 运行所有确定性脚本，保存检测报告
6. 用户填写10维评分量规
7. 生成三阶段 diff 对比文件

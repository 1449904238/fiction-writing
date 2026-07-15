# 基线样本生成指南（V5.1）

> 本指南说明如何使用完整流水线生成基线样本，用于后续规则迭代的回归测试。

## 前提条件

1. 已有完整的小说项目（00设定+01大纲+02细纲）
2. 选择3种不同类型的章节作为基线：
   - **战斗章**：验证动作描写、节奏控制、战力一致性
   - **日常章**：验证对话风格、角色辨识度、信息密度
   - **情绪章**：验证情绪工程、用户锚点融入、质感深化

## 生成步骤

### Step 1: 准备输入
```
samples/baseline/chXX_类型/
├── chXX_细纲.md          — 从02复制对应章节的细纲+衔接包
└── chXX_评分.json        — 复制 scoring_template.json
```

### Step 2: 执行完整流水线（/flow_full）
```
1. 03a_扩写执行.md → 生成初稿 → 保存为 chXX_03a_初稿.md
2. 03b_质量自检.md → 生成质检报告 → 保存为 chXX_03b_质检.md
3. 04_小说正文精修师.md → 生成精修稿 → 保存为 chXX_04_精修.md
4. 05_去AI味精修师.md → 生成终稿 → 保存为 chXX_05_终稿.md
```

### Step 3: 运行确定性脚本
```bash
# 在终稿上运行所有脚本，保存报告
node scripts/check-ai-patterns.js --json 终稿.md > chXX_检测报告.json
node scripts/check-degeneration.js --json 终稿.md >> chXX_检测报告.json
node scripts/normalize-punctuation.js --check 终稿.md >> chXX_检测报告.json
node scripts/check-consistency.js --meta=设定/JSON元数据.json 终稿.md >> chXX_检测报告.json
node scripts/check-emotion-density.js --json --anchor=解气 终稿.md >> chXX_检测报告.json
node scripts/extract-used-patterns.js --json --n=3 前章文件... >> chXX_检测报告.json
```

### Step 4: 三阶段对比
```
创建 chXX_diff对比.md，逐段对比：
- 03a初稿 vs 04精修：质感提升了多少？哪些句子被改？
- 04精修 vs 05终稿：AI味减少了多少？哪些模式被修？
- 03a初稿 vs 05终稿：总变化量，是否有过度修改？
```

### Step 5: 填写评分
```
根据脚本报告和人工评估，填写 chXX_评分.json：
- 10个维度各0-10分
- 总分100分
- 等级：>85通过 / 76-85基本合格 / 60-75需修改 / <60需重写
```

### Step 6: 锁定基线
```
基线样本一旦建立，不随规则迭代修改。
后续规则变更后，用同样输入重新生成（regression/YYYYMMDD_chXX/），对比是否退化。
```

## 回归测试触发条件

每次以下变更后执行回归测试：
- skill文件修改（03a/03b/04/05/02 任何规则变更）
- 新增/删除/修改确定性脚本
- references素材库变更

## 回归测试通过标准

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| 总分 | 10维评分 | 回归样本总分≥基线总分-5分 |
| 字数 | check-ai-patterns.js | 3500-4500字 |
| 对话占比 | check-ai-patterns.js | ≤60% |
| Burstiness | check-ai-patterns.js | >0.35 |
| 标点限额 | check-ai-patterns.js | 省略号≤5/破折号≤4/感叹号≤15 |
| AI味模式 | check-ai-patterns.js | 无新增AI味模式 |
| 跨章重复 | extract-used-patterns.js | 无新增重复 |
| 情绪密度 | check-emotion-density.js | 5-12/千字 |
| blocking数 | 所有脚本 | 回归≤基线 |
| INC要素 | 人工评估 | ≥3/13 |

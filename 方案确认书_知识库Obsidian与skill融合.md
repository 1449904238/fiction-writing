# 方案确认书：知识库 Obsidian 落库 + book-distillation-kb 与技能融合

> 状态：**✅ 已执行完毕（含用户调整项）**（2026-08-30）
> 最终执行口径：A1 方法论库 ✅ / A2 **移动**（md 视图进 vault，作家/ 侧只留 json；练习卡 md 归档 .workbuddy/archive_md/）✅ / A3 **raw 复制进库 + 源书转全文 md 进库**（方法论库/raw/ 116 文件 + 两本 原书全文.md）✅ / B1-B2 **蒸馏相关全撤**（拆文师回退 V7.0.1、vault distill-book.md 移入备份、workflows 恢复 8、retrieval-rules 清引用）✅ / B3 scripts/ ✅ / B4 备份 ✅ / book-distillation-kb 与蒸馏流程不再维护
> 最终形态：vault 方法论库 231 个 md（卡片 112 + 原书全文 2 + raw 116 + README）；作家/学习资料/ 保留 json 权威 + raw + 规范 + 清单；7 个技能引用 json（写作配合主链路）
> 2026-08-30 二轮调整：**知识库唯一权威整体迁至 vault**（json 卡片+md+raw+原书全文全在 方法论库/）；7 技能引用路径 `../学习资料/` → `C:/fuhui/ObsidianStore/writer/方法论库/`（13 处）；vault 清理（删 欢迎.md、写作项目/对标拆解库/styles 空目录）；生成器改为纯 json 渲染、确定性文件名、断链 0。  
> 日期：2026-08-30  
> 涉及位置：
>
> - `C:\Users\14499\Desktop\小说\skill\作家\学习资料\`（技能侧知识库，已存在）
> - `C:\fuhui\ObsidianStore\writer\`（Obsidian 库，已存在，写作闭环方案 v3.1 落地）
> - `C:\Users\14499\.workbuddy\skills\book-distillation-kb\`（用户级蒸馏流程技能，已存在）

---

## 0. 目标与原则

| 原则      | 内容                                               |
| ------- | ------------------------------------------------ |
| 单点权威    | 机读 json（技能读）留在 `作家/学习资料/`，不移动 → 已接入的 3 处技能引用零风险  |
| 双视图     | 技能读 json，人/图谱看 md；md 可由 json 脚本再生成，防漂移           |
| 归层判断    | 按 vault README 既有标准：换书不变→Skill 层（方法），换书会变→库层（内容） |
| 引用不复制   | 共享解析脚本三方引用，不复制副本（沿用技能家族既有约定）                     |
| 库不可读→降级 | 所有新增引用保持"不可读不阻断"约束（沿用现有约定）                       |

---

## 1. 现状盘点（已核实）

### 1.1 学习资料/（技能侧，112 张 json 全部校验通过）

- 知识卡片 27 张（20 情节 + 7 理论，json+md 成对）
- 练习卡 82 张 + 索引（json+md 成对）
- 规则与清单 3 份（json）
- 卡片规范.md、README.md
- raw/ 115 个分章文件（中间产物）
- 源书 epub/mobi 2 个（用户自备）

### 1.2 Obsidian 库 writer/（v3.1 落地，结构完整、尚无内容）

- `.obsidian/` 存在（真 vault）
- README.md = AI 查库第一入口；CLAUDE.md / .cursorrules / system-prompt.md = 平台适配器
- `Skill/`：SCHEMA.md（宪法）+ workflows 8 个（init-project / create-style / write-chapter / write-outline / review-chapter / accept-chapter / reverse-adjust / deconstruct-book）+ references/retrieval-rules.md + rules/（global-rules.md、rules.yaml R001-R026）+ templates/
- `对标拆解库/`、`styles/`、`写作项目/`：空目录，尚无书
- active-book.yaml：未锁定任何书
- 结论：**结构有用、内容待填充**，适合作为知识库的 Obsidian 侧家园

### 1.3 技能（作家/ 共 14 个目录）

- 已接入知识库引用：细纲生成（02a）、细纲扩写执行（03a）、多视角审稿师（09）
- 候选融合：小说拆文师（07）、小说导入师、项目初始化师
- 不融合：短篇写作技能、质量自检、细纲质检、正文终稿打磨师、读者反馈注入师

### 1.4 book-distillation-kb（用户级流程技能）

- 内容：电子书→知识卡的四阶段工序（解析/切分/蒸馏/校验接入），无书籍内容
- 定位：方法论（换书不变），归 Skill 层

---

## 2. 方案 A：Obsidian 落库

### A.1 架构（单点权威 + 双视图）

```
作家/学习资料/                          ← 机读权威（技能引用，不动）
├── 知识卡片/plot01-20_*.json          ← 技能读这里
├── 练习卡/ex005-089_*.json
├── 规则与清单/checklist_*.json
├── raw/                                ← 卡片 source 回查（不进 vault）
└── 卡片规范.md / README.md

C:/fuhui/ObsidianStore/writer/
└── 方法论库/                            ← 人读/图谱视图（新增）
    ├── 经典情节20种/
    │   ├── _MOC_情节库.md               ← wikilink 导航页
    │   ├── plot01_探寻.md ... plot20_沉.md   ← md 卡片（含 frontmatter）
    │   └── theory_1~7.md
    └── 开始写吧/
        ├── _MOC_练习库.md
        └── ex005~ex089.md + 练习卡索引.md
```

### A.2 卡片改造内容（全部 md，不动 json）

1. **YAML frontmatter**：每张卡顶部加 `id` / `type`（动作|头脑情节）/ `section` / `use_when` / `author`，供 Dataview 查询
2. **wikilink 互链**：
   - 理论卡 ↔ 情节卡（如 theory_4 链接全部 20 张情节卡）
   - 情节卡 ↔ 示例（示例作品名可不链，避免悬空）
   - 练习卡 ↔ 相关情节卡（按 use_when 关联）
3. **tags**：`#写作/情节`、`#写作/理论`、`#练习/视角` 等
4. **MOC 索引页**：每个子库一个导航页，wikilink 全列出

### A.3 检索示例（Dataview 语法）

```dataview
TABLE use_when AS 适用场景, section AS 板块
FROM "方法论库/开始写吧"
WHERE contains(use_when, "卡文热手")
```

```dataview
LIST FROM "方法论库/经典情节20种" WHERE type = "头脑情节"
```

### A.4 不进 vault 的内容

- `raw/`（115 个中间文件，体量大，无图谱价值）
- 两本源书文件
- json（vault 不需要机读层；若需要也可后补，默认不复制）

---

## 3. 方案 B：book-distillation-kb 与技能融合

### B.1 融合总表

| 对象                                 | 融合方式            | 改动内容                                                                                             | 风险            |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ | ------------- |
| vault `Skill/workflows/`           | **并进（Skill 层）** | 新增 `distill-book.md`（蒸馏流程 4 阶段，含共享脚本调用）；`retrieval-rules.md` 补"知识卡检索规则"一节；README.md 目录结构补"方法论库/" | 低，纯新增         |
| book-distillation-kb（~/.workbuddy） | 定位调整            | 标注 `superseded by writer/Skill/workflows/distill-book.md`，或保留为通用模板（二选一，待定）                       | 低             |
| 小说拆文师                              | **输入路由（V8.0）**  | SKILL.md 增加"输入类型路由"：小说→原拆解管线（拆文库/）；方法论书→蒸馏管线（方法论库/）。版本按惯例升 V8.0                                  | 中，需按其版本/合规约定改 |
| 小说导入师                              | **解析层共享**       | 新增 `作家/scripts/parse-ebook.py`（从蒸馏脚本提炼），拆文师/导入师/蒸馏三方引用                                           | 低             |
| 项目初始化师                             | **挂载步骤**        | 初始骨架增加可选"知识库挂载检查"（检测 `学习资料/` 与 vault `方法论库/`，缺失仅提示不阻断）                                           | 低             |
| 已接入 3 技能                           | 不合并             | 保持 `../学习资料/` 引用                                                                                 | 无             |

### B.2 拆文师 V8.0 路由草案（示意）

```
输入类型判断
├─ 小说/爆款/对标作品 → 原拆解管线 → 拆文库/{书名}/（市场/文本/结构）
└─ 写作方法论书籍 → 蒸馏管线（distill-book）→ vault 方法论库/{书名}/
    ├─ 解析：parse-ebook.py → raw/
    ├─ 蒸馏：知识卡/练习卡/清单（json+md）
    ├─ 落库：md 卡进 vault 方法论库/（frontmatter+wikilink+tag+MOC）
    └─ 校验：json 全量校验 + 来源回查
```

### B.3 共享解析脚本 parse-ebook.py

- 位置：`作家/scripts/parse-ebook.py`（或 `作家/共享脚本/`，待定）
- 能力：epub（ebooklib spine 顺序）/ mobi（mobi.extract + mbp:pagebreak 分章）/ txt
- 调用方：book-distillation-kb（vault distill-book.md）、拆文师、导入师
- 依据"引用不复制"：只在一处维护

---

## 4. 执行顺序（分 5 阶段，每阶段可单独确认/中止）

| 阶段 | 内容                                                                 | 产出                     | 可否独立确认 |
| -- | ------------------------------------------------------------------ | ---------------------- | ------ |
| P1 | vault 落库：写脚本批量生成 vault 版 md（frontmatter+wikilink+tag+MOC）→ `方法论库/` | 2 个 MOC + 109 张 md     | ✅      |
| P2 | 抽共享解析脚本 parse-ebook.py                                             | scripts/parse-ebook.py | ✅      |
| P3 | vault Skill 层并入：distill-book.md + retrieval-rules 更新 + README 更新   | 3 个文件改动                | ✅      |
| P4 | 拆文师 V8.0 输入路由                                                      | 拆文师/SKILL.md 改动        | ✅      |
| P5 | 项目初始化师挂载步骤                                                         | 项目初始化师/SKILL.md 改动     | ✅      |

## 5. 风险与回滚

| 风险                   | 等级 | 缓解                                         |
| -------------------- | -- | ------------------------------------------ |
| 双份 md（作家/ + vault）漂移 | 中  | md 由 json 脚本生成，重新生成即同步；`卡片规范.md` 注明生成关系    |
| 拆文师 V8.0 改动破坏既有拆解流程  | 中  | 路由为"前置判断"，原拆解管线零改动；git/备份后改                |
| vault 打开大目录卡顿        | 低  | 方法论库仅 110 个 md，无压力                         |
| 技能引用路径破坏             | 低  | json 不移动，引用不动                              |
| 回滚                   | —  | P1-P3 全部为新增文件/新增节，删除即回滚；P4 改 SKILL.md 前先备份 |

## 6. 待确认清单（请逐项回复）

- [ ] A1：方法论库目录名用 `方法论库/` 还是 `对标拆解库/方法论/`？（推荐前者）
- [ ] A2：vault 版 md 是**复制**（保留作家/ 侧 md，推荐）还是**移动**（仅 vault 持有 md）？
- [ ] A3：源书 epub/mobi 与 raw/ 维持现状不进 vault，是否同意？
- [ ] B1：蒸馏流程并入 vault `Skill/workflows/distill-book.md`，同时 ~/.workbuddy 版标注 superseded——是否同意？还是保留双份？
- [ ] B2：拆文师 V8.0 输入路由本次做，还是拆到下一轮？
- [ ] B3：共享脚本放 `作家/scripts/` 还是 `作家/共享脚本/`？（推荐 scripts/）
- [ ] B4：是否先备份（zip 学习资料/ 与三技能）再执行 P1-P5？
- [ ] 执行范围：全做 / 只做 P1+P2 / 只做 P1？

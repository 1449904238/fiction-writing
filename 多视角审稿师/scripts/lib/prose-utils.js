'use strict';

/**
 * prose-utils.js — 散文检测脚本共享工具函数库
 *
 * 从 check-ai-patterns.js / check-degeneration.js / check-rhythm.js /
 * normalize-punctuation.js 中提取的公共函数，消除重复定义。
 *
 * 用法：
 *   const { stripQuoted, visibleLength, isDivider, isStructural,
 *           hasYamlFrontMatter, splitSentences, parseFenceMarker } = require('./lib/prose-utils.js');
 *
 * 注意：require 路径相对于调用脚本所在目录（scripts/），因此 './lib/prose-utils.js'
 * 解析为 scripts/lib/prose-utils.js。
 */

// ──────────────────────────────────────────────────────────
//  统一阈值常量（V5.3.1 新增 — 供 check-ai-patterns.js / check-quality-score.js 等引用）
//  消除各脚本各自硬编码阈值导致的不一致问题
// ──────────────────────────────────────────────────────────

/** TTR 词汇多样性告警阈值（词级，低于此值=advisory） */
const TTR_THRESHOLD = 0.25;

/** 比喻密度 blocking 阈值（每千字，超过此值=blocking） */
const METAPHOR_DENSITY_BLOCK = 4.0;

/** burstiness CV 告警阈值（低于此值=节奏过于均匀，advisory/blocking 分界参考） */
const BURSTINESS_CV_THRESHOLD = 0.35;

/**
 * burstiness CV 评分梯度阈值（V5.4.1 新增 — 供 check-quality-score.js 引用）
 *
 * 说明：check-ai-patterns.js 与 check-quality-score.js 对 burstiness CV 使用不同阈值是
 * **设计意图**，而非不一致：
 *   - check-ai-patterns.js 是"AI模式检测"视角：CV < 0.35 = blocking（AI节奏指纹明显）
 *   - check-quality-score.js 是"质量评分"视角：CV 0.3/0.5 是评分梯度（满分/及格/不及格）
 *
 * 以下常量统一管理评分梯度阈值，消除 check-quality-score.js 中的硬编码 0.3/0.5。
 */
/** burstiness CV 评分满分阈值（≥此值=满分15分） */
const BURSTINESS_CV_SCORE_FULL = 0.5;

/** burstiness CV 评分及格阈值（≥此值=及格10分，<此值=不及格0分） */
const BURSTINESS_CV_SCORE_PASS = 0.3;

// ──────────────────────────────────────────────────────────
//  对话引用去除
// ──────────────────────────────────────────────────────────

/**
 * 去除文本中的对话引用内容（引号/书名号内的内容）
 * 支持中文引号（""''）、日文引号（「」『』）、书名号（【】）、英文引号（"'）
 * @param {string} t - 原始文本
 * @returns {string} - 去除对话后的纯叙述文本
 */
function stripQuoted(t) {
  return t
    .replace(/「[^」]*」/g, '')
    .replace(/『[^』]*』/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/\u201c[^\u201d]*\u201d/g, '')
    .replace(/\u2018[^\u2019]*\u2019/g, '');
}

// ──────────────────────────────────────────────────────────
//  可见字符长度
// ──────────────────────────────────────────────────────────

/**
 * 计算可见字符长度（中日韩统一表意文字 + 全角字母 + ASCII 字母数字）
 * 不计入标点、空格、换行等不可见字符
 * @param {string} s - 输入字符串
 * @returns {number} - 可见字符数量
 */
function visibleLength(s) {
  const m = s.match(/[\u4e00-\u9fff\uFF21-\uFF5AA-Za-z0-9]/g);
  return m ? m.length : 0;
}

// ──────────────────────────────────────────────────────────
//  结构标记检测
// ──────────────────────────────────────────────────────────

/**
 * 判断文本是否为 markdown 分隔线（--- / *** / ___）
 * @param {string} t - 待检测文本（已 trim）
 * @returns {boolean}
 */
function isDivider(t) {
  return /^-{3,}$/.test(t) || /^[*_]{3,}$/.test(t);
}

/**
 * 判断文本是否为 markdown 结构性标记（标题/引用/列表/表格行）
 * @param {string} t - 待检测文本（已 trim）
 * @returns {boolean}
 */
function isStructural(t) {
  return /^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(t);
}

// ──────────────────────────────────────────────────────────
//  YAML 前置标记检测
// ──────────────────────────────────────────────────────────

/**
 * 检测文本行数组是否以 YAML front matter 开头
 * front matter 格式：首行 ---，后续为 key: value，以 --- 闭合
 * @param {string[]} lines - 文本行数组
 * @returns {boolean} - 是否存在有效的 YAML front matter
 */
function hasYamlFrontMatter(lines) {
  if (!lines[0] || lines[0].trim() !== '---') return false;
  let s = false;
  for (let i = 1; i < Math.min(lines.length, 40); i += 1) {
    const t = lines[i].trim();
    if (t === '---') return s;
    if (/^[A-Za-z0-9_-]+:\s*/.test(t)) s = true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────
//  句子分割
// ──────────────────────────────────────────────────────────

/**
 * 按句末标点分割文本为句子数组
 * 分隔符：。！？!?…\n（连续分隔符合并，不产生空句子）
 * @param {string} t - 输入文本
 * @returns {string[]} - 分割后的句子数组（已 trim，过滤空串）
 */
function splitSentences(t) {
  return t.split(/[。！？!?…\n]+/).map((s) => s.trim()).filter(Boolean);
}

// ──────────────────────────────────────────────────────────
//  代码块标记解析
// ──────────────────────────────────────────────────────────

/**
 * 解析 markdown 代码块围栏标记（``` 或 ~~~）
 * @param {string} t - 待检测文本（已 trim）
 * @returns {{char: string, length: number}|null} - 标记字符与长度，非围栏行返回 null
 */
function parseFenceMarker(t) {
  const m = /^(?:`{3,}|~{3,})/.exec(t);
  if (!m) return null;
  return { char: m[0][0], length: m[0].length };
}

// ──────────────────────────────────────────────────────────
//  Burstiness 计算（V3.0 新增 — 句长变异度）
// ──────────────────────────────────────────────────────────

/**
 * 计算文本的 burstiness（突发性/句长变异度）
 * AI 文本句长分布过于均匀（CV 低），人类长短句交替变化剧烈（CV 高）
 * 对标 GPTZero / Turnitin AI Detection 的 burstiness 维度
 * @param {string[]} sentences - 句子数组（已分割）
 * @returns {{cv: number, mean: number, stdDev: number, count: number}}
 */
function calculateBurstiness(sentences) {
  const lens = sentences.map(s => visibleLength(s)).filter(l => l > 0);
  if (lens.length < 5) return { cv: 0, mean: 0, stdDev: 0, count: 0 };
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((s, l) => s + (l - mean) * (l - mean), 0) / lens.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 0;
  return { cv, mean, stdDev, count: lens.length };
}

// ──────────────────────────────────────────────────────────
//  中文分词（V3.1 新增 — 正向最大匹配，零 npm 依赖）
// ──────────────────────────────────────────────────────────

/**
 * 常用中文词汇表（双字/三字/四字词）
 * 覆盖代词/副词/动词/形容词/名词等高频词，用于正向最大匹配分词。
 * 词级 TTR 比字符级 TTR 更准确地反映词汇多样性（字符级会高估多样性）。
 * 来源：现代汉语常用词表 + 网文叙事高频词人工筛选
 */
const COMMON_WORDS = new Set([
  // ── 代词/指示词（约30）──
  '他们', '她们', '我们', '你们', '自己', '别人', '他人', '大家', '咱们',
  '这里', '那里', '哪里', '这边', '那边', '这边', '此处', '彼处',
  '这个', '那个', '哪个', '这些', '那些', '什么', '怎么', '为何', '为何',
  '这样', '那样', '怎样', '为什么', '怎么样', '于是', '因此', '所以',
  '然而', '但是', '不过', '可是', '虽然', '尽管', '即使', '哪怕',

  // ── 副词/时间/程度（约70）──
  '已经', '正在', '刚刚', '马上', '立刻', '顿时', '突然', '忽然',
  '慢慢', '渐渐', '终于', '终究', '仍然', '依然', '还是', '也许',
  '或许', '可能', '似乎', '好像', '仿佛', '简直', '几乎', '甚至',
  '至少', '最多', '确实', '的确', '其实', '实在', '真的', '真正',
  '非常', '十分', '特别', '尤其', '格外', '极其', '极为', '最为',
  '稍微', '略微', '稍稍', '不断', '不停', '不住', '不禁', '不由',
  '一时', '一旦', '一面', '一边', '一同', '一起', '一共', '总共',
  '悄悄', '暗暗', '默默', '静静', '缓缓', '轻轻', '微微', '淡淡',
  '深深', '远远', '高高', '低低', '匆匆', '迟迟', '早早', '迟早',
  '一直', '一向', '始终', '永不', '从不', '绝不', '未必', '不禁',
  '忽然', '蓦地', '倏地', '陡然', '骤然', '猛然', '霎时', '瞬间',

  // ── 动词（约150）──
  '开始', '结束', '继续', '停止', '完成', '进行', '发生', '出现',
  '消失', '发现', '发觉', '觉得', '认为', '以为', '知道', '了解',
  '理解', '明白', '记得', '忘记', '想起', '回忆', '思考', '考虑',
  '决定', '选择', '希望', '期待', '想要', '需要', '必须', '应该',
  '可以', '能够', '愿意', '试图', '设法', '努力', '尽力', '竭力',
  '奋力', '用力', '转身', '回头', '抬头', '低头', '点头', '摇头',
  '挥手', '招手', '伸手', '放手', '松手', '握手', '拍手', '鼓掌',
  '跺脚', '迈步', '跨步', '退后', '向前', '起身', '站起', '坐下',
  '躺下', '蹲下', '弯腰', '挺胸', '闭眼', '睁眼', '眨眼', '皱眉',
  '咬牙', '张嘴', '闭嘴', '叹气', '喘气', '呼吸', '吞咽', '咳嗽',
  '微笑', '大笑', '苦笑', '哭泣', '落泪', '流泪', '抽泣', '呐喊',
  '喊叫', '嘶吼', '怒吼', '低语', '呢喃', '嘀咕', '说话', '告诉',
  '回答', '询问', '追问', '质问', '解释', '说明', '描述', '介绍',
  '建议', '议论', '讨论', '争论', '辩论', '吵架', '打架', '战斗',
  '搏斗', '厮杀', '追逐', '逃跑', '逃离', '躲避', '躲藏', '隐藏',
  '寻找', '搜寻', '探索', '察觉', '注意', '关注', '留意', '在意',
  '介意', '计较', '算计', '盘算', '计划', '策划', '安排', '准备',
  '等待', '迎接', '离开', '到达', '进入', '走出', '跑出', '飞出',
  '跳出', '爬上', '爬下', '穿过', '经过', '路过', '越过', '跨过',
  '绕过', '推开', '拉开', '关上', '打开', '合上', '翻开', '翻过',
  '撕开', '撕碎', '折断', '打碎', '破碎', '修复', '修理', '建造',
  '搭建', '拆除', '毁灭', '摧毁', '破坏', '保护', '守护', '保卫',
  '防御', '攻击', '进攻', '反击', '还击', '抵抗', '反抗', '投降',
  '屈服', '妥协', '让步', '坚持', '放弃', '抓住', '握紧', '放开',
  '释放', '解放', '拯救', '营救', '帮助', '协助', '支持', '反对',
  '赞成', '同意', '拒绝', '否认', '承认', '坦白', '交代', '隐瞒',
  '欺骗', '背叛', '出卖', '忠诚', '服从', '听从', '遵守', '违背',
  '维持', '保持', '改变', '转变', '转化', '变成', '成为', '显得',
  '看着', '望着', '盯着', '凝视', '注视', '打量', '端详', '扫视',
  '环视', '巡视', '凝望', '眺望', '仰望', '俯视', '俯瞰', '窥视',

  // ── 形容词（约90）──
  '美丽', '漂亮', '丑陋', '难看', '好看', '精致', '粗糙', '光滑',
  '柔软', '坚硬', '温暖', '寒冷', '凉爽', '炎热', '潮湿', '干燥',
  '明亮', '黑暗', '昏暗', '阴沉', '晴朗', '清澈', '浑浊', '透明',
  '干净', '肮脏', '整洁', '凌乱', '破旧', '崭新', '古老', '神秘',
  '平凡', '伟大', '渺小', '巨大', '庞大', '微小', '精细', '粗大',
  '细长', '短小', '高大', '矮小', '肥胖', '瘦弱', '强壮', '虚弱',
  '健康', '年轻', '苍老', '年迈', '幼小', '成熟', '稚嫩', '粗暴',
  '温柔', '凶猛', '温顺', '勇敢', '怯懦', '胆小', '鲁莽', '谨慎',
  '小心', '大意', '粗心', '细心', '认真', '马虎', '严肃', '活泼',
  '沉闷', '热闹', '冷清', '安静', '喧哗', '嘈杂', '宁静', '平静',
  '激动', '兴奋', '紧张', '放松', '轻松', '沉重', '痛苦', '快乐',
  '悲伤', '愤怒', '高兴', '难过', '失望', '满足', '饥饿', '饱足',
  '疲惫', '困倦', '清醒', '迷糊', '清楚', '模糊', '明显', '隐晦',
  '直接', '间接', '简单', '复杂', '容易', '困难', '简洁', '冗长',
  '精彩', '无聊', '有趣', '枯燥', '生动', '死板', '灵活', '僵硬',
  '敏捷', '迟钝', '聪明', '愚笨', '智慧', '愚蠢', '机智', '狡猾',
  '诚实', '虚伪', '真诚', '善良', '恶毒', '慈悲', '残忍', '温和',
  '暴躁', '耐心', '急躁', '冷漠', '热情', '冷酷', '无情', '多情',
  '绝情', '痴情', '深情', '柔情', '激情', '热烈', '冷淡', '淡漠',

  // ── 名词（约130）──
  '时候', '时间', '时刻', '地方', '地点', '位置', '方向', '方面',
  '世界', '天地', '天空', '大地', '山川', '河流', '海洋', '湖泊',
  '森林', '沙漠', '草原', '山谷', '山峰', '山脚', '山顶', '悬崖',
  '峭壁', '洞穴', '隧道', '道路', '街道', '巷子', '广场', '公园',
  '花园', '庭院', '院子', '房屋', '房子', '建筑', '楼房', '高楼',
  '大厦', '宫殿', '城堡', '城墙', '城门', '大门', '房门', '窗户',
  '屋顶', '墙壁', '地板', '楼梯', '台阶', '走廊', '阳台', '厨房',
  '卧室', '客厅', '书房', '家具', '桌子', '椅子', '床铺', '沙发',
  '柜子', '书架', '衣柜', '镜子', '灯具', '蜡烛', '火把', '篝火',
  '火焰', '烟雾', '灰烬', '雨滴', '雨水', '雪花', '冰块', '露水',
  '云朵', '彩虹', '闪电', '雷声', '雷电', '阳光', '月光', '星光',
  '灯光', '影子', '倒影', '颜色', '声音', '气味', '味道', '感觉',
  '情绪', '心情', '思绪', '念头', '想法', '主意', '计划', '目的',
  '目标', '原因', '理由', '结果', '后果', '效果', '影响', '作用',
  '力量', '能力', '技能', '本领', '办法', '方法', '方式', '途径',
  '手段', '工具', '武器', '刀剑', '枪械', '弓箭', '盾牌', '铠甲',
  '衣服', '裤子', '鞋子', '帽子', '围巾', '手套', '腰带', '首饰',
  '戒指', '项链', '书籍', '卷轴', '信件', '纸张', '笔墨', '墨水',
  '食物', '米饭', '面条', '馒头', '包子', '饺子', '糕点', '水果',
  '蔬菜', '肉类', '鱼肉', '鸡肉', '牛肉', '羊肉', '猪肉', '茶水',
  '酒水', '药物', '毒药', '解药', '金钱', '铜钱', '银两', '金子',
  '银子', '珠宝', '宝石', '玉石', '水晶', '矿石', '人物', '男人',
  '女人', '孩子', '老人', '少年', '少女', '青年', '朋友', '敌人',
  '伙伴', '同伴', '战友', '对手', '陌生人', '家人', '父母', '父亲',
  '母亲', '兄弟', '姐妹', '儿子', '女儿', '丈夫', '妻子', '情人',
  '主人', '仆人', '客人', '师傅', '徒弟', '老师', '学生', '故事',
  '传说', '传闻', '消息', '信息', '情报', '秘密', '真相', '谜团',
  '疑惑', '疑问', '答案', '线索', '证据', '话语', '言语', '语言',
  '文字', '符号', '标记', '痕迹', '足迹', '脚印', '血迹', '汗水',
  '泪水', '呼吸', '心跳', '脉搏', '身体', '躯体', '手臂', '手掌',
  '手指', '手腕', '肩膀', '胸膛', '胸口', '背部', '腰部', '腹部',
  '大腿', '小腿', '膝盖', '脚踝', '脚掌', '头部', '脸庞', '面容',
  '面颊', '额头', '眉毛', '眼睛', '眼眶', '眼角', '瞳孔', '鼻子',
  '嘴巴', '嘴唇', '牙齿', '舌头', '下巴', '耳朵', '脖颈', '喉咙',
  '头发', '发丝', '胡须', '皱纹', '疤痕', '伤口', '伤痕', '血液',
  '鲜血', '骨骼', '骨头', '肌肉', '经脉', '血管', '神经', '皮肤',
  '肌肤',

  // ── 三字词（约18）──
  '陌生人', '为什么', '怎么样', '不由得', '不一定', '不知道',
  '不可不', '来不及', '说不定', '看样子', '怎么说', '怎么办',
  '差不多', '一会儿', '这时候', '那回事', '打交道', '忍不住',

  // ── 四字词/成语（约49）──
  '与此同时', '不知不觉', '不约而同', '不由自主', '不寒而栗',
  '不可置信', '不可名状', '不可思议', '不言而喻', '显而易见',
  '顺其自然', '理所当然', '毋庸置疑', '至关重要', '刻不容缓',
  '迫不及待', '义不容辞', '责无旁贷', '挺身而出', '恍然大悟',
  '豁然开朗', '若有所思', '若有所悟', '若即若离', '心不在焉',
  '心知肚明', '心领神会', '心照不宣', '心事重重', '漫不经心',
  '不以为然', '不以为意', '不动声色', '不露声色', '目不转睛',
  '聚精会神', '全神贯注', '屏息凝视', '纹丝不动', '稳如泰山',
  '安如磐石', '雷厉风行', '大刀阔斧', '斩钉截铁', '语重心长',
  '意味深长', '耐人寻味', '发人深省', '引人深思', '栩栩如生',
  '历历在目', '记忆犹新', '记忆深刻', '过目不忘'
]);

/**
 * 中文正向最大匹配分词（零 npm 依赖）
 * 算法：从文本起始位置扫描，对中文字符尝试从最长(4)到最短(2)匹配 COMMON_WORDS，
 *       匹配失败则单字独立；非中文字符中，英文/数字连续序列作为一个 token，标点/空白跳过。
 * @param {string} text - 输入文本
 * @returns {string[]} - 分词后的 token 数组
 */
function segmentChinese(text) {
  const tokens = [];
  const len = text.length;
  let i = 0;
  // 预编译字符类别正则（避免循环内重复编译）
  const isCnRe = /[\u4e00-\u9fff]/;
  const isAlnumRe = /[A-Za-z0-9]/;
  while (i < len) {
    const ch = text[i];
    if (isCnRe.test(ch)) {
      // 中文字符：正向最大匹配，从最长(4)开始尝试
      let matched = false;
      for (let l = 4; l >= 2; l -= 1) {
        if (i + l <= len) {
          const candidate = text.slice(i, i + l);
          if (COMMON_WORDS.has(candidate)) {
            tokens.push(candidate);
            i += l;
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        // 匹配失败，单字独立
        tokens.push(ch);
        i += 1;
      }
    } else if (isAlnumRe.test(ch)) {
      // 英文/数字连续序列作为一个 token
      let j = i + 1;
      while (j < len && isAlnumRe.test(text[j])) {
        j += 1;
      }
      tokens.push(text.slice(i, j));
      i = j;
    } else {
      // 标点/空白跳过
      i += 1;
    }
  }
  return tokens;
}

// ──────────────────────────────────────────────────────────
//  TTR 词汇多样性计算（V3.1 词级 — Type-Token Ratio）
// ──────────────────────────────────────────────────────────

/**
 * 计算文本的词汇多样性指数（Type-Token Ratio）— 词级
 * AI 文本 TTR 偏低（用词重复度高），人类文本 TTR 较高。
 * V3.1 改为词级分词（segmentChinese 正向最大匹配），替代原字符级分割。
 * 词级 TTR 普遍低于字符级 TTR（因多字词被合并为单个 token），
 * 故 check-ai-patterns.js 的告警阈值已从 0.4 同步下调至 0.25。
 * 使用滑动窗口（默认500词）避免长文本 TTR 自然下降。
 * 参考：Kobak et al. 研究发现 AI 辅助写作后 TTR 统计显著下降
 * @param {string} text - 输入文本
 * @param {number} windowSize - 滑动窗口大小（默认500词；V3.1 从字符改为词）
 * @returns {{overallTTR: number, minWindowTTR: number, windows: number[]}}
 */
function calculateTTR(text, windowSize = 500) {
  // 词级分词（替代原单字分割 text.match(/[\u4e00-\u9fff]/g)）
  const tokens = segmentChinese(text);
  if (!tokens || tokens.length < 50) return { overallTTR: 0, minWindowTTR: 0, windows: [] };

  // 整体 TTR（词级）
  const uniqueOverall = new Set(tokens);
  const overallTTR = uniqueOverall.size / tokens.length;

  // 滑动窗口 TTR（按词数而非字数）
  const windows = [];
  for (let i = 0; i + windowSize <= tokens.length; i += windowSize) {
    const window = tokens.slice(i, i + windowSize);
    const unique = new Set(window);
    windows.push(unique.size / window.length);
  }
  // 如果文本不足一个窗口，用整体 TTR
  if (windows.length === 0) windows.push(overallTTR);

  const minWindowTTR = Math.min(...windows);
  return { overallTTR, minWindowTTR, windows };
}

// ──────────────────────────────────────────────────────────
//  AI 过渡句模式化检测（V3.0 新增）
// ──────────────────────────────────────────────────────────

/**
 * AI 高频过渡句模式检测
 * AI 文本倾向使用模板化过渡句，人类口语化写作极少出现
 * @param {string} narrative - 纯叙述文本（已去除对话）
 * @returns {{count: number, instances: Array<{word: string, position: number}>}}
 */
function detectTransitionPatterns(narrative) {
  const transitions = [
    '首先', '其次', '最后', '与此同时', '在这个瞬间',
    '不禁', '不由得', '值得注意的是', '综上所述',
    '总而言之', '换言之', '不可否认', '毋庸置疑',
    '在这个过程中', '与此同时', '就在这时',
    '一时间', '刹那间', '须臾间',
  ];
  const instances = [];
  let count = 0;
  for (const word of transitions) {
    let idx = narrative.indexOf(word);
    while (idx !== -1) {
      count++;
      if (instances.length < 20) {
        instances.push({ word, position: idx });
      }
      idx = narrative.indexOf(word, idx + word.length);
    }
  }
  return { count, instances };
}

// ──────────────────────────────────────────────────────────
//  信息密度均匀性检测（V3.0 新增）
// ──────────────────────────────────────────────────────────

/**
 * 计算文本分段后的信息密度方差
 * AI 文本信息密度过于均匀（缺乏张弛），人类写作有明显的张弛节奏
 * 信息密度 = (对话字数 + 动作词字数) / 总字数
 * @param {string} text - 原始文本（含对话）
 * @param {number} segmentSize - 分段大小（默认500字）
 * @returns {{variance: number, densities: number[], mean: number}}
 */
function calculateInfoDensityVariance(text, segmentSize = 500) {
  const chars = text.match(/[\u4e00-\u9fff\u201c\u201d\uff01\uff1f\u3002\uff0c]/g);
  if (!chars || chars.length < segmentSize) return { variance: 0, densities: [], mean: 0 };

  // 动作/对话特征字符
  const dialogueChars = text.match(/[\u201c\u201d]/g) || [];
  // V5.3.1 修复：用 segmentChinese() 分词 + Set 精确匹配替代 split(verb) 子串匹配
  // 旧代码 segment.split(verb).length - 1 会误匹配复合词（如"走廊"中的"走"），导致计数虚高
  const actionVerbSet = new Set(['走','跑','跳','说','看','想','拿','放','坐','站','转','回','伸','握','抬']);
  
  const densities = [];
  for (let i = 0; i + segmentSize <= text.length; i += segmentSize) {
    const segment = text.slice(i, i + segmentSize);
    const segChars = segment.match(/[\u4e00-\u9fff]/g) || [];
    if (segChars.length === 0) continue;
    const dialogueCount = (segment.match(/[\u201c\u201d]/g) || []).length;
    const tokens = segmentChinese(segment);
    let actionCount = tokens.filter(t => actionVerbSet.has(t)).length;
    densities.push((dialogueCount + actionCount) / segChars.length);
  }
  
  if (densities.length < 2) return { variance: 0, densities, mean: densities[0] || 0 };
  
  const mean = densities.reduce((a, b) => a + b, 0) / densities.length;
  const variance = densities.reduce((s, d) => s + (d - mean) * (d - mean), 0) / densities.length;
  return { variance, densities, mean };
}

// ──────────────────────────────────────────────────────────
//  V5.3.1 新增：5个 Gate 检测函数（P1-10）
//  供 check-ai-patterns.js 调用，检测 AI 文本中高频出现的套路化模式
// ──────────────────────────────────────────────────────────

/**
 * 检测段首过渡词堆叠
 * AI 文本倾向在段落开头堆叠"然而/不过/与此同时/于是"等转折/递进连接词
 * @param {string} text - 原始全文
 * @returns {{detected: boolean, count: number, matches: Array<{text: string, position: number}>, severity: string}}
 */
function detectTransitionStacking(text) {
  const transitions = ['然而', '不过', '与此同时', '于是'];
  const matches = [];
  // 按换行分割，检测每段开头是否以目标词起始
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.length > 0) {
      for (const word of transitions) {
        if (trimmed.startsWith(word)) {
          // 计算在原文中的绝对位置
          const leadingWS = line.length - trimmed.length;
          const pos = offset + leadingWS;
          matches.push({ text: word, position: pos });
          break; // 每段只匹配一个
        }
      }
    }
    offset += line.length + 1; // +1 for newline
  }
  const count = matches.length;
  const detected = count >= 3;
  return { detected, count, matches, severity: detected ? 'advisory' : 'info' };
}

/**
 * 检测排比句式滥用
 * 1. "不是A而是B" 句式 ≥2次/章（单独出现已由 check-ai-patterns.js blocking，此处检测累计频率）
 * 2. 连续3+句相同结构排比（如"他XXX，他XXX，他XXX"）
 * @param {string} text - 原始全文
 * @returns {{detected: boolean, count: number, matches: Array<{text: string, position: number}>, severity: string}}
 */
function detectParallelismAbuse(text) {
  const matches = [];

  // 1. "不是A而是B" 累计计数
  const notIsRe = /不是[^，。！？\n]{2,40}(?:而是|只有|唯有|那是一种)/g;
  let m;
  notIsRe.lastIndex = 0;
  let notIsCount = 0;
  while ((m = notIsRe.exec(text)) !== null) {
    notIsCount++;
    if (matches.length < 20) {
      matches.push({ text: m[0].slice(0, 30), position: m.index });
    }
  }

  // 2. 连续3+句相同结构排比检测
  // 提取叙述句子（按句末标点分割）
  const sentences = text.split(/[。！？!?…\n]+/).map(s => s.trim()).filter(Boolean);
  let parallelismCount = 0;
  for (let i = 0; i + 2 < sentences.length; i++) {
    const s1 = sentences[i];
    const s2 = sentences[i + 1];
    const s3 = sentences[i + 2];
    // 检测前缀相同（前2-4字相同）且长度相近的连续3句
    const prefixLen = Math.min(4, s1.length, s2.length, s3.length);
    if (prefixLen >= 2) {
      const p1 = s1.slice(0, prefixLen);
      const p2 = s2.slice(0, prefixLen);
      const p3 = s3.slice(0, prefixLen);
      if (p1 === p2 && p2 === p3 && p1.length >= 2) {
        parallelismCount++;
        if (matches.length < 20) {
          matches.push({ text: `${s1.slice(0, 20)}|${s2.slice(0, 20)}|${s3.slice(0, 20)}`, position: text.indexOf(s1) });
        }
      }
    }
  }

  const count = notIsCount + parallelismCount;
  // 排比结构≥1次=blocking；"不是A而是B"≥2次=advisory
  const detected = parallelismCount >= 1 || notIsCount >= 2;
  const severity = parallelismCount >= 1 ? 'blocking' : (notIsCount >= 2 ? 'advisory' : 'info');
  return { detected, count, matches, severity };
}

/**
 * 检测模糊时间跳跃词
 * AI 文本倾向使用"不知过了多久/片刻之后/须臾间/不知不觉"等模糊时间词跳转场景
 * @param {string} text - 原始全文
 * @returns {{detected: boolean, count: number, matches: Array<{text: string, position: number}>, severity: string}}
 */
function detectVagueTimeJump(text) {
  const timeWords = ['不知过了多久', '片刻之后', '须臾间', '不知不觉', '不知何时', '转眼间', '霎时间'];
  const matches = [];
  for (const word of timeWords) {
    let idx = text.indexOf(word);
    while (idx !== -1) {
      matches.push({ text: word, position: idx });
      idx = text.indexOf(word, idx + word.length);
    }
  }
  const count = matches.length;
  const detected = count >= 2;
  return { detected, count, matches, severity: detected ? 'advisory' : 'info' };
}

/**
 * 检测套路化外貌描写词
 * AI 文本倾向使用"剑眉星目/肤若凝脂/一袭白衣"等套路化外貌词，缺乏个性
 * @param {string} text - 原始全文
 * @returns {{detected: boolean, count: number, matches: Array<{text: string, position: number}>, severity: string}}
 */
function detectClichedAppearance(text) {
  const cliches = [
    '剑眉星目', '肤若凝脂', '一袭白衣', '倾国倾城', '眉目如画',
    '五官轮廓分明', '眼神深邃', '嘴角微扬', '肌肤胜雪', '明眸皓齿',
    '面如冠玉', '风度翩翩', '冰肌玉骨', '国色天香',
  ];
  const matches = [];
  for (const word of cliches) {
    let idx = text.indexOf(word);
    while (idx !== -1) {
      matches.push({ text: word, position: idx });
      idx = text.indexOf(word, idx + word.length);
    }
  }
  const count = matches.length;
  const detected = count >= 1;
  return { detected, count, matches, severity: detected ? 'advisory' : 'info' };
}

/**
 * 检测气声对话标签堆叠
 * AI 文本倾向滥用"低声道/轻声说/喃喃道/低语/呢喃/沙哑着嗓子说"等气声对话标签
 * @param {string} text - 原始全文
 * @returns {{detected: boolean, count: number, matches: Array<{text: string, position: number}>, severity: string}}
 */
function detectBreathyDialogueTags(text) {
  const tags = ['低声道', '轻声说', '喃喃道', '低语', '呢喃', '沙哑着嗓子说', '低声说', '柔声说', '轻声道'];
  const matches = [];
  for (const word of tags) {
    let idx = text.indexOf(word);
    while (idx !== -1) {
      matches.push({ text: word, position: idx });
      idx = text.indexOf(word, idx + word.length);
    }
  }
  const count = matches.length;
  const detected = count >= 4;
  return { detected, count, matches, severity: detected ? 'advisory' : 'info' };
}

// ──────────────────────────────────────────────────────────
//  导出
// ──────────────────────────────────────────────────────────

module.exports = {
  stripQuoted,
  visibleLength,
  isDivider,
  isStructural,
  hasYamlFrontMatter,
  splitSentences,
  parseFenceMarker,
  calculateBurstiness,
  calculateTTR,
  detectTransitionPatterns,
  calculateInfoDensityVariance,
  segmentChinese,
  COMMON_WORDS,
  TTR_THRESHOLD,
  METAPHOR_DENSITY_BLOCK,
  BURSTINESS_CV_THRESHOLD,
  BURSTINESS_CV_SCORE_FULL,
  BURSTINESS_CV_SCORE_PASS,
  detectTransitionStacking,
  detectParallelismAbuse,
  detectVagueTimeJump,
  detectClichedAppearance,
  detectBreathyDialogueTags,
};

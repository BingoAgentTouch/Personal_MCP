// ============================================================
// watcher/words.ts — 纠错词表 + 转述前缀 + 双层检测
//
// 可配置常量，待实测收敛。词表只是第一道粗筛，最终价值靠离线审阅。
// ============================================================

/** 纠错词表（三组，初始，可配置，待实测收敛） */
export const ERROR_WORDS: readonly string[] = [
	// 直接不满
	"不对", "错了", "不行", "不好", "有误", "不是这个", "我说的是", "换个说法", "搞错了", "没找到",
	// 程度不满（用户对产出的量化不满）
	"太大", "太小", "太快", "太慢", "太吵", "太丑", "太暗", "太亮", "太高", "太低",
	// 修正/重做
	"重新", "重来", "再改",
];

/** 转述前缀（assistant 消息专用，可配置） */
export const TRANSCRIPT_PREFIXES: readonly string[] = [
	"用户反馈", "用户要求", "用户澄清", "用户指出", "用户抱怨", "用户觉得", "用户认为",
];

/** user_text 截断上限 */
const USER_TEXT_MAX = 200;

/**
 * 对 text 做纠错词表匹配，返回第一个命中的词；无命中返回 null。
 * 中文无分词，直接 includes；词表均为两字及以上，无单字误匹配风险。
 */
export function matchErrorWord(text: string): string | null {
	for (const word of ERROR_WORDS) {
		if (text.includes(word)) return word;
	}
	return null;
}

/**
 * 检测 assistant 消息中的转述前缀。
 * 分隔符放宽为：冒号（全角：或半角:）、引号（双引号"或单引号'）、或直接接文字（无分隔符）。
 * 三种情况均返回前缀与分隔符后的剩余文本（直接接文字时 rest = 前缀后的全部文本）。
 * 设计原因：真实数据中「用户反馈"雨声太大了"」（引号）和「用户反馈对话功能不可用」（无分隔符）
 * 均为有效转述，原仅认冒号的实现会漏掉这两类（材料包 §3.5 实测发现）。
 */
export function matchTranscriptPrefix(text: string): { prefix: string; rest: string } | null {
	for (const prefix of TRANSCRIPT_PREFIXES) {
		const idx = text.indexOf(prefix);
		if (idx >= 0) {
			const after = text.slice(idx + prefix.length);
			// 冒号（全角：或半角:）
			if (after.startsWith("：") || after.startsWith(":")) {
				return { prefix, rest: after.slice(1).trim() };
			}
			// 引号（双引号"或单引号'，含全角双引号"）
			if (after.startsWith('"') || after.startsWith("'") || after.startsWith("\u201C")) {
				return { prefix, rest: after.slice(1).trim() };
			}
			// 直接接文字（无分隔符）——前缀后第一个字符若是中文/字母则视为转述
			// 排除空白后为空的情况（如「用户反馈」后无内容）
			const trimmed = after.trim();
			if (trimmed.length > 0) {
				return { prefix, rest: trimmed };
			}
		}
	}
	return null;
}

/**
 * 双层检测：判断一轮 turn 是否命中负反馈。
 *  - user 消息：直接对 content 做纠错词表匹配
 *  - assistant 消息：仅当含转述前缀时，对前缀后文本做纠错词表匹配
 * 命中返回 { from, signal_word, user_text }；未命中返回 null。
 */
export function detectTurn(
	role: "user" | "assistant",
	content: string,
): { from: "user" | "assistant_transcript"; signal_word: string; user_text: string } | null {
	if (role === "user") {
		const word = matchErrorWord(content);
		if (word) {
			return { from: "user", signal_word: word, user_text: truncate(content) };
		}
		return null;
	}
	if (role === "assistant") {
		const pm = matchTranscriptPrefix(content);
		if (pm) {
			const word = matchErrorWord(pm.rest);
			if (word) {
				return { from: "assistant_transcript", signal_word: word, user_text: truncate(pm.rest) };
			}
		}
		return null;
	}
	return null;
}

function truncate(s: string): string {
	return s.length > USER_TEXT_MAX ? s.slice(0, USER_TEXT_MAX) + "…" : s;
}

// ============================================================
// P2 权重系统 · 第一期单测（node:test）
// 把《记忆权重方案》里每张对照表和效果示例转成可执行断言。
// 运行： npm test
// ============================================================

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decayFloor, effectiveImportance } from "../src/search/retriever.ts";
import { DEFAULT_META } from "../src/storage/fragments.ts";

describe("decay_floor 映射（decay_floor = 0.4×importance + 0.3）", () => {
	const cases: Array<[number, number]> = [
		[0.95, 0.68],
		[0.85, 0.64],
		[0.7, 0.58],
		[0.5, 0.5],
		[0.4, 0.46],
		[0.15, 0.36],
	];
	for (const [imp, expected] of cases) {
		test(`importance ${imp} → floor ${expected}`, () => {
			assert.ok(Math.abs(decayFloor(imp) - expected) < 0.005, `got ${decayFloor(imp)}`);
		});
	}
});

describe("权重恒为纯衰减（≤ 1.0，实际 ≤ 0.7）", () => {
	test("importance=1.0 → floor ≤ 0.7", () => {
		assert.ok(decayFloor(1.0) <= 0.7);
	});
	test("importance=0.0 → floor = 0.3（下限）", () => {
		assert.ok(Math.abs(decayFloor(0.0) - 0.3) < 1e-9);
	});
	test("越界输入被夹取 [0,1]", () => {
		assert.equal(decayFloor(-5), decayFloor(0));
		assert.equal(decayFloor(5), decayFloor(1));
	});
});

describe("相对重排（final = similarity × decay_floor）", () => {
	test("架构决策(0.55×imp0.95) 反超 闲聊(0.60×imp0.15)", () => {
		const a = 0.55 * decayFloor(0.95); // 架构决策，中等相关
		const b = 0.6 * decayFloor(0.15); // 闲聊，较相关
		assert.ok(a > b, `a=${a} b=${b}`);
	});
	test("重要性压不过明显的相似度差距：功能实现(0.75×imp0.70) 仍居首", () => {
		const c = 0.75 * decayFloor(0.7); // 功能实现，很相关又较重要
		const a = 0.55 * decayFloor(0.95); // 架构决策，中等相关
		assert.ok(c > a, `c=${c} a=${a}`);
	});
});

describe("P3 Phase 1c earned 重排", () => {
	test("earned 缺失时按 0 处理，不改变 base importance", () => {
		assert.equal(effectiveImportance({ importance: 0.7 }), 0.7);
	});
	test("earned 低于 base 时不会降低权重", () => {
		const base = effectiveImportance({ importance: 0.7, earned_importance: 0.1 });
		assert.equal(base, 0.7);
		assert.equal(decayFloor(base), decayFloor(0.7));
	});
	test("earned 超过 base 时才提升有效重要性", () => {
		const effective = effectiveImportance({ importance: 0.7, earned_importance: 0.8 });
		assert.equal(effective, 0.8);
		assert.ok(decayFloor(effective) > decayFloor(0.7));
	});
});

describe("缺失 meta 向后兼容", () => {
	// readMeta 对缺失文件返回 {...DEFAULT_META}，故等价于验证默认值链路。
	// 直接断言常量以保持测试无磁盘副作用。
	test("默认 importance = 0.5", () => {
		assert.equal(DEFAULT_META.importance, 0.5);
	});
	test("缺失 meta（importance=0.5）→ 中性权重 0.5", () => {
		assert.ok(Math.abs(decayFloor(DEFAULT_META.importance) - 0.5) < 1e-9);
	});
});

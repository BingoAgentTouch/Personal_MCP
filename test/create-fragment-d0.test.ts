import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mcp-d1-"));

let handleStoreTurn: typeof import("../src/mcp/handlers.ts").handleStoreTurn;
let handleCreateFragment: typeof import("../src/mcp/handlers.ts").handleCreateFragment;
let handleSearch: typeof import("../src/mcp/handlers.ts").handleSearch;
let createGeneration: typeof import("../src/embedding/generation.ts").createGeneration;
let setGenerationExpectedCount: typeof import("../src/embedding/generation.ts").setGenerationExpectedCount;
let writeGenerationVector: typeof import("../src/embedding/generation.ts").writeGenerationVector;
let finalizeGeneration: typeof import("../src/embedding/generation.ts").finalizeGeneration;
let activateGeneration: typeof import("../src/embedding/generation.ts").activateGeneration;

before(async () => {
	process.chdir(tempRoot);
	({ handleStoreTurn, handleCreateFragment, handleSearch } = await import("../src/mcp/handlers.ts"));
	({
		createGeneration,
		setGenerationExpectedCount,
		writeGenerationVector,
		finalizeGeneration,
		activateGeneration,
	} = await import("../src/embedding/generation.ts"));
});

after(() => {
	process.chdir(originalCwd);
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function snapshot(root: string): Map<string, string> {
	const files = new Map<string, string>();
	if (!fs.existsSync(root)) return files;
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else files.set(path.relative(root, fullPath), fs.readFileSync(fullPath, "utf8"));
		}
	};
	visit(root);
	return files;
}

function assertSnapshotEqual(actual: Map<string, string>, expected: Map<string, string>): void {
	assert.deepEqual([...actual].sort(), [...expected].sort());
}

let generationSequence = 0;

async function installActiveGeneration(): Promise<string> {
	generationSequence += 1;
	const generationId = `gen_d1_active_${generationSequence}`;
	const fragmentId = `2026-08-04/frag_${String(generationSequence).padStart(3, "0")}`;
	const manifest = await createGeneration(generationId, "sha256:d1-fixture", 384);
	setGenerationExpectedCount(generationId, 1);
	writeGenerationVector(manifest, fragmentId, new Array(384).fill(0), {
		source_content_hash: "sha256:d1-source",
		input_hash: "sha256:d1-input",
		tokens: { used: 1 },
	});
	finalizeGeneration(generationId);
	activateGeneration(generationId);
	return generationId;
}

describe("Phase D1 delta write path", () => {
	test("rejects fragment creation when no active generation exists", async () => {
		await handleStoreTurn({ date: "2026-08-04", role: "user", content: "D1 no-active fixture turn" });
		const memoryRoot = path.join(tempRoot, "memory");
		const before = snapshot(memoryRoot);

		const result = await handleCreateFragment({
			date: "2026-08-04",
			start_turn_id: "turn_0001",
			end_turn_id: "turn_0001",
			task_desc: "D1 requires active generation",
			result_desc: "must reject without legacy embedding fallback",
			tags: ["d1"],
			topic_name: "embedding",
		});

		assert.equal(result.isError, true);
		const payload = JSON.parse(result.content[0].text);
		assert.equal(payload.code, "ACTIVE_GENERATION_REQUIRED");
		assert.match(payload.message, /没有 active embedding generation/);
		assertSnapshotEqual(snapshot(memoryRoot), before);
	});

	test("creates a fragment through delta and makes it searchable", async () => {
		await handleStoreTurn({ date: "2026-08-04", role: "user", content: "D1 searchable delta turn" });
		const generationId = await installActiveGeneration();
		const memoryRoot = path.join(tempRoot, "memory");

		const result = await handleCreateFragment({
			date: "2026-08-04",
			start_turn_id: "turn_0001",
			end_turn_id: "turn_0001",
			task_desc: "D1 active generation delta write",
			result_desc: "new fragment should be visible immediately",
			tags: ["d1", "delta"],
			topic_name: "embedding",
		});

		assert.equal(result.isError, undefined);
		const payload = JSON.parse(result.content[0].text);
		assert.equal(payload.embedding_layer, "delta");
		assert.equal(payload.embedding_generation, generationId);
		assert.match(payload.embedding_delta_id, /^delta_\d{8}_001$/);
		assert.equal(fs.existsSync(path.join(memoryRoot, "fragments", "2026-08-04", "frag_001.md")), true);
		assert.equal(fs.existsSync(path.join(memoryRoot, "embedding_delta", "manifest.json")), true);
		assert.equal(fs.existsSync(path.join(memoryRoot, "embedding_delta", "delta_index.json")), true);
		assert.equal(fs.existsSync(path.join(memoryRoot, "embedding_delta", "vectors", "2026-08-04", "frag_001.embedding")), true);

		const search = await handleSearch({ query: "D1 active generation delta write", top_k: 5 });
		assert.equal(search.isError, undefined);
		const searchPayload = JSON.parse(search.content[0].text);
		assert.equal(searchPayload.results[0].fragment_id, "2026-08-04/frag_001");
		assert.equal(searchPayload.results[0].embedding_layer, "delta");
		assert.equal(searchPayload.health.status, "healthy_with_delta");
	});

	test("backfill refuses an active generation without changing it", async () => {
		const generationId = await installActiveGeneration();
		const memoryRoot = path.join(tempRoot, "memory");
		const before = snapshot(memoryRoot);
		const script = path.join(projectRoot, "backfill_embeddings.mjs");

		assert.throws(
			() => execFileSync(process.execPath, [script], { cwd: tempRoot, encoding: "utf8", stdio: "pipe" }),
			(error: any) => error.status === 2 && /只读快照/.test(String(error.stderr)),
		);
		assertSnapshotEqual(snapshot(memoryRoot), before);
		assert.equal(fs.existsSync(path.join(memoryRoot, "embedding_generations", generationId, "generation_index.json")), true);
	});
});

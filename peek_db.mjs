import { open } from "node:fs/promises";

const dbPath = "D:/LenovoSoftstore/CherryData/Data/agents.db";

try {
	// Read first 100 bytes to see file type
	const handle = await open(dbPath, "r");
	const buf = Buffer.alloc(4096);
	await handle.read(buf, 0, 4096, 0);
	await handle.close();

	const text = buf.toString("utf-8");
	// Try to extract table names from SQLite schema
	const matches = text.match(/CREATE TABLE\s+\w+\s*\([^)]+\)/gi);
	if (matches) {
		console.log("=== 找到的表结构 ===");
		for (const m of matches) {
			console.log(m.slice(0, 500));
			console.log("---");
		}
	} else {
		// Just show non-null readable strings
		console.log("=== 数据库头512字节(可读部分) ===");
		console.log(text.slice(0, 512));
	}
} catch (e) {
	console.error("错误:", e.message);
}

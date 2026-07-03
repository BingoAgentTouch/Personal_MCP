import * as fs from "node:fs";
import * as path from "node:path";

const dbPath = "D:/LenovoSoftstore/CherryData/Data/agents.db";

if (!fs.existsSync(dbPath)) {
	console.error("agents.db not found at", dbPath);
	process.exit(1);
}

// Read raw bytes of the first 1024 bytes to check SQLite header
const fd = fs.openSync(dbPath, "r");
const buf = Buffer.alloc(1024);
fs.readSync(fd, buf, 0, 1024, 0);
fs.closeSync(fd);

console.log("=== File header (hex) ===");
console.log(buf.slice(0, 16).toString("hex"));

// Check if it's SQLite format
const header = buf.slice(0, 16).toString();
console.log("=== Header string ===");
console.log(header);

// aiKart "Try Me Now" sandbox entry point (Agent Manifest Guide v1, section 4: runtime contract).
// Reads the buyer's inputs, runs the agent once, writes { format, response } to /aikart/output.json, exits 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeInput, runAgent, toMarkdown } from "../lib/agent.ts";

const IN = "/aikart/input.json";
const OUT = process.env.AIKART_OUTPUT ?? "/aikart/output.json"; // override only for local testing

function write(response: string) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ format: "markdown", response }));
}

const raw = process.env.AIKART_INPUT || (existsSync(IN) ? readFileSync(IN, "utf8") : "");
const input = normalizeInput(raw ? JSON.parse(raw) : null);

if (!input) {
  write("Please describe your situation: age, state, village or city, work, family income and ration card.");
} else {
  // Sandbox has no secrets and usually no network: the agent runs in offline mode and skips the PIN lookup gracefully.
  const result = await runAgent({ ...input, message: input.message.slice(0, 2000) });
  write(toMarkdown(result));
}

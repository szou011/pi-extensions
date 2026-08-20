/**
 * uv-enforce.ts
 *
 * Enforces the workspace's "uv only" Python policy (see AGENTS.md) inside pi by
 * HARD-BLOCKING any `bash` tool call that invokes `python` / `python3` / `pip` /
 * `pip3` as a real command. Enforcement is made visible to BOTH:
 *
 *   - the AGENT: the bash tool returns a blocked error containing an explicit,
 *     copy-pasteable uv rewrite, so the model learns the rule;
 *   - the HUMAN: a UI notification (footer/toast) is emitted for each block.
 *
 * Only *genuine* command invocations are blocked. The detector strips quoted
 * strings and `#` comments (respecting `#` inside quotes) so text like
 * `grep python file`, `echo "run python"`, or a `# python note` comment does
 * NOT trigger a false positive.
 *
 * Loaded from `.pi/extensions/` (project-local, auto-discovered after trust).
 * Hot-reload with the `/reload` command.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/** Commands that must never run directly. */
const FORBIDDEN = new Set(["python", "python3", "pip", "pip3"]);

/**
 * The teaching message returned as the tool error (visible to the agent) and
 * included in the human-facing notification. Maps each violation to the uv
 * idiom described in AGENTS.md.
 */
function guidance(tok: string): string {
	// pip has several valid rewrites; present all.
	if (tok.startsWith("pip")) {
		return [
			`'pip install X'  ->  'uv add X'  (project dependency)`,
			`'pip install X'  ->  'uv run --with X <cmd>'  (one-off script)`,
			`prefer PEP 723 inline deps in the script: uv add --script script.py X`,
		].join("  |  ");
	}
	// python / python3 both map to uv run.
	return `'${tok} script.py'  ->  'uv run python script.py'`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command: string = event.input.command;
		const bad = scanForForbiddenCommand(command);
		if (!bad) return; // no genuine python/pip invocation -> allow

		const reason =
			`BLOCKED by uv-enforce: direct '${bad.token}' is forbidden in this workspace ` +
			`(all Python runs through 'uv'). Rewrite and retry:\n` +
			guidance(bad.token);

		// Human-visible enforcement notification: the viewer sees each block and
		// the teaching guidance, so enforcement is auditable in real time.
		if (ctx.hasUI) {
			ctx.ui.notify(`uv-enforce: blocked direct \`${bad.token}\`; agent was asked to rewrite to uv`, "warning");
		}

		// Agent-visible: the bash tool reports this as an error result.
		return { block: true, reason, terminate: false };
	});
}

type Forbidden = { token: string } | undefined;

const spaces = /\s+/;

/**
 * Splits a whitespace-delimited token on literal `&&`, `||`, `;`, `|`, `&`,
 * `(`, `)`. These are bash operators that may be glued to neighboring words
 * (e.g. `(python a.py)`, `x&`, `a&&b`). Breaking them out lets the command
 * detector see `python` as a real command position instead of a run-on token.
 */
function splitOperators(tok: string): string[] {
	return tok.split(/(&&|\|\||;|\||&|\(|\))/).filter(Boolean);
}

/**
 * Tokenizes the quote/comment-stripped command into whitespace-delimited words
 * (keeping `&&`, `||`, `;`, `|` operators as tokens so we can detect command
 * boundaries) and returns the first forbidden token that is the ACTUAL command
 * being run — i.e. the first non-operator, non-env-assignment word of a
 * sub-command.
 *
 * This means `grep python file.txt`, `alias python=x`, `echo "use python"`,
 * `pythonic`, and valid `uv run python main.py` are NOT blocked, while
 * `python script.py`, `cd x && python a.py`, `FOO=1 python`, and
 * `(python a.py) &` ARE blocked.
 */
function scanForForbiddenCommand(command: string): Forbidden {
	const stripped = stripQuotesAndComments(command);
	// Tokenize: split on whitespace AND on bash operator characters, so
	// `cd x && python a.py` and `(python a.py)` tokenize into separate
	// command/argument tokens rather than run-together lumps.
	const words = stripped.split(spaces).filter(Boolean).map(splitOperators).flat();

	let expectCommand = true; // true when next meaningful word must be a command

	for (const w of words) {
		// Command operators reset the position so the next word is a command.
		if (w === "&&" || w === "||") {
			expectCommand = true;
			continue;
		}
		if (w === ";" || w === "|" || w === "(" || w === "&") {
			expectCommand = true;
			continue;
		}
		if (w === ")") {
			continue;
		}

		// Skip env-assignment prefixes (FOO=1 / VAR=value) when at command spot.
		if (expectCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
			continue; // still expectCommand for the real command after them
		}

		// If we're at a command position and this word is forbidden -> block.
		if (expectCommand && FORBIDDEN.has(w)) {
			return { token: w };
		}

		// Any other word (the command itself, or an argument) means subsequent
		// words in this simple-command are arguments, not commands.
		expectCommand = false;
	}

	return undefined;
}

/**
 * Removes everything inside single/double quotes and from `#` to end-of-line,
 * so the tokenizer only sees literal command/argument words that bash would
 * actually attempt to run.
 */
function stripQuotesAndComments(s: string): string {
	let out = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			out += " "; // replace quote with space so words stay separated
			i++;
			continue;
		}
		if (ch === '"') {
			if (!inSingle) inDouble = !inDouble;
			out += " ";
			i++;
			continue;
		}
		if (inSingle || inDouble) {
			out += " "; // swallow quoted content (not executable as a word)
			i++;
			continue;
		}
		if (ch === "#") break; // rest of line is a comment
		out += ch;
		i++;
	}
	return out;
}

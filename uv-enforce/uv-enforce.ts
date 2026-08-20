/**
 * uv-enforce.ts
 *
 * Enforces the workspace's "uv only" Python policy (see AGENTS.md) inside pi by
 * HARD-BLOCKING any `bash` tool call that runs Python directly (outside `uv`).
 * Enforcement is made visible to BOTH:
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
 * Detected violations:
 *   - direct commands: `python`, `python3`, `pip`, `pip3`, `pipx`;
 *   - manual venv creation: `python -m venv .venv` (only when `python` is the
 *     actual command, so `uv run python -m venv` stays allowed);
 *   - manual venv activation: `source .venv/bin/activate` / `. .../activate`;
 *   - command substitution `$(python ...)` (caught because the `(` operator
 *     resets the scanner to command position).
 *
 * Loaded from `.pi/extensions/` (project-local, auto-discovered after trust).
 * Hot-reload with the `/reload` command.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/** Direct commands that must never run. */
const FORBIDDEN = new Set(["python", "python3", "pip", "pip3"]);
/** Commands that must never be the leading word of a command. */
const FORBIDDEN_LEADERS = new Set(["pipx"]);
/** Bash operators that separate simple commands; after one, expect a command. */
const COMMAND_OPERATORS = new Set(["&&", "||", ";", "|", "&", "("]);

/**
 * The teaching message returned as the tool error (visible to the agent) and
 * included in the human-facing notification. Maps each violation to the uv
 * idiom described in AGENTS.md.
 */
function guidance(tok: string): string {
	if (tok === "python -m venv") {
		return [
			`'python -m venv .venv'  ->  let 'uv run' manage the project env (uv creates/uses .venv automatically)`,
			`'python -m venv .venv'  ->  'uv init' + 'uv run ...' for a fresh project`,
		].join("  |  ");
	}
	if (tok === "source .../activate") {
		return `no manual activation: 'source .venv/bin/activate'  ->  'uv run <cmd>' already uses the locked project env`;
	}
	if (tok === "pipx") {
		return [
			`'pipx install X'  ->  'uvx X'  (one-off)`,
			`'pipx install X'  ->  'uv tool install X'  (persistent)`,
		].join("  |  ");
	}
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
			`BLOCKED by uv-enforce: '${bad.token}' is forbidden in this workspace ` +
			`(all Python runs through 'uv'). Rewrite and retry:\n` +
			guidance(bad.token);

		// Human-visible enforcement notification: the viewer sees each block and
		// the teaching guidance, so enforcement is auditable in real time.
		if (ctx.hasUI) {
			ctx.ui.notify(`uv-enforce: blocked \`${bad.token}\`; agent was asked to rewrite to uv`, "warning");
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
 * (e.g. `(python a.py)`, `x&`, `a&&b`, `$(python ...)` -> `$` + `(` + `python`).
 * Breaking them out lets the detector see `python` as a real command position
 * instead of a run-on token, and lets the `(` operator reset the scanner for
 * command substitutions.
 */
function splitOperators(tok: string): string[] {
	return tok.split(/(&&|\|\||;|\||&|\(|\))/).filter(Boolean);
}

/**
 * Tokenizes the quote/comment-stripped command into whitespace-delimited words
 * (keeping bash operators as tokens) and walks them with simple-command-aware
 * position tracking. Returns the first forbidden token, describing the ACTUAL
 * command being run, or undefined.
 *
 * Detection logic per word:
 *   - after a `&&`/`||`/`;`/`|`/`&`/`(` operator, or an env-assignment prefix,
 *     the next word must be a command;
 *   - at command position: a forbidden command name/leader blocks; `python -m
 *     venv` gets a specific manual-venv message; `source`/`.` mark that the next
 *     arg activates a venv;
 *   - in argument position: `python`/`pip` are allowed (e.g. `uv run python`,
 *     `uv run pip install`); only an activation path (`.../activate`) blocks.
 *
 * This means `grep python file.txt`, `alias python=x`, `echo "use python"`,
 * `pythonic`, `uv run python main.py`, `uv run pip install X`, `cd venv`, and
 * `grep activate file` are NOT blocked, while `python script.py`,
 * `cd x && python a.py`, `FOO=1 python`, `(python a.py) &`, `pipx install X`,
 * `python -m venv .venv`, `source .venv/bin/activate`, and `$(python -c ...)`
 * ARE blocked.
 */
function scanForForbiddenCommand(command: string): Forbidden {
	const text = stripQuotesAndComments(command);
	// Tokenize: split on whitespace AND on bash operator characters, so
	// `cd x && python a.py`, `(python a.py)`, and `$(python ...)` tokenize into
	// separate command/argument/operator tokens rather than run-together lumps.
	const tokens = text.split(spaces).filter(Boolean).map(splitOperators).flat();

	let expectCommand = true; // true when next meaningful word must be a command
	let sourceBuiltin = false; // true right after a `source` / `.` command

	for (let i = 0; i < tokens.length; i++) {
		const w = tokens[i];

		// Command operators reset the position so the next word is a command.
		if (COMMAND_OPERATORS.has(w)) {
			expectCommand = true;
			sourceBuiltin = false;
			continue;
		}
		if (w === ")") {
			continue;
		}

		// Skip env-assignment prefixes (FOO=1 / VAR=value) when at command spot.
		if (expectCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
			sourceBuiltin = false;
			continue; // still expectCommand for the real command after them
		}

		if (expectCommand) {
			expectCommand = false;
			sourceBuiltin = w === "source" || w === ".";

			// Manual venv creation gets a specific, teaching message. Only match
			// when python is genuinely the command, so `uv run python -m venv`
			// (python as an argument) stays allowed.
			if ((w === "python" || w === "python3") && tokens[i + 1] === "-m" && tokens[i + 2] === "venv") {
				return { token: "python -m venv" };
			}

			// Direct forbidden command, or a forbidden leader like pipx.
			if (FORBIDDEN.has(w) || FORBIDDEN_LEADERS.has(w)) {
				return { token: w };
			}
			continue;
		}

		// Argument position: python/pip are fine (uv run python, uv run pip).
		// Only a venv activation path is forbidden here. `$(` closes via the `(`
		// operator, so a genuine `$(python ...)` sub-command is caught above.
		if (w.endsWith("/activate") || (sourceBuiltin && w === "activate")) {
			return { token: "source .../activate" };
		}
		// After the first argument of a source command, `source x && ...`: the
		// next command is handled by the operator reset above.
		sourceBuiltin = false;
	}

	return undefined;
}

/**
 * Removes everything inside single/double quotes and from `#` to end-of-line,
 * so the tokenizer only sees literal command/argument words that bash would
 * actually attempt to run. (Backslash escapes are deliberately not resolved;
 * see README: this targets a cooperative agent, not adversarial evasion.)
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

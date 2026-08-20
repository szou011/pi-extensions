# uv-enforce

A project-local [pi](https://pi-coding.org) extension that enforces the workspace's **"uv only" Python policy** by hard-blocking `bash` tool calls that invoke `python` / `python3` / `pip` / `pip3` directly.

All Python in this workspace must run through `uv` (see `AGENTS.md`). This extension turns that written policy into an active guard inside the coding agent.

---

## Objectives

- **Prevent direct-Python execution** — block `bash` commands that run real `python` / `python3` / `pip` / `pip3` against the system environment, which the policy forbids (it can pollute system Python, bypass the locked project env, or use an unmanaged interpreter).
- **Teach by blocking** — when a violation is caught, the `bash` tool returns an error containing a copy-pasteable `uv` rewrite, so the agent models the correct idiom on the spot.
- **Make enforcement auditable** — every block also emits a human-visible UI notification (`warning` toast), so no enforcement happens silently.
- **Avoid false positives** — only *genuine* command invocations are blocked; references to these words in arguments, strings, comments, filenames, or as part of longer words are left alone.

---

## Usage

### Installation / loading

The extension is auto-discovered from the project-local extensions directory:

```
.pi/extensions/uv-enforce.ts
```

- It loads automatically after the directory is trusted.
- Hot-reload changes with the `/reload` command.

### What it does at runtime

On each `bash` tool call, the extension:

1. Strips quoted strings and `#`‑to‑end-of-line comments.
2. Tokenizes the command on whitespace and bash operators (`&&`, `||`, `;`, `|`, `&`, `(`, `)`).
3. Tracks *command position* — the first meaningful, non-operator, non-env-assignment word of each sub-command.
4. If a command-position word is `python`, `python3`, `pip`, or `pip3`, it **blocks the call** and returns a teaching message with the correct `uv` replacement.

### Blocked examples

```bash
python script.py
python3 -m mypkg
pip install requests
cd x && python a.py
( python a.py ) &
FOO=1 python main.py
```

Each produces a message like:

```
BLOCKED by uv-enforce: direct 'python' is forbidden in this workspace
(all Python runs through 'uv'). Rewrite and retry:
'python script.py'  ->  'uv run python script.py'
```

For `pip` the guidance lists all valid rewrites (`uv add`, `uv run --with`, and PEP 723 inline deps via `uv add --script`).

### Allowed (not blocked)

These are allowed because the forbidden words are **not** in command position:

```bash
uv run python main.py      # python is an argument to uv run
grep python README.md       # argument
echo "run python here"      # inside a quoted string
# a python code note        # comment
pythonic                    # different word
alias python=x              # alias target, not a command
```

---

## Advantages

- **Semantically correct detection** — command-position analysis, not naive substring matching, so it reliably separates *running* python from *mentioning* it.
- **Low false-positive rate** — quoted strings, comments, arguments, and longer words are ignored.
- **Agent + human feedback** — the model is taught via the error message *and* a human sees each block in the UI, keeping enforcement transparent and auditable.
- **Non-catastrophic** — `terminate: false` means one blocked call does not abort the whole turn; only the offending command is rejected.
- **Minimal and dependency-free** — a single self-contained file, no build step, no external state, uses only pi's stable `tool_call` event API.
- **Policy-complete pip guidance** — maps each offending token to the right `uv` idiom (add vs. one-off vs. PEP 723 inline deps).

---

## Limitations

- **`bash` tool only** — enforcement happens at execution time and only for the `bash` tool. It does not inspect `write` / `edit` / `read` tool content, so a script *containing* a forbidden command is not flagged at authoring time.
- **Coverage gaps vs. the policy** — only the four command names are caught. Other policy-prohibited patterns from `AGENTS.md` (`python -m venv`, `source .venv/bin/activate`, `pipx`) are not detected.
- **Not a real shell parser** — it models a subset of shell word-expansion (quotes, comments, whitespace, basic operators). Theses are **known, accepted gaps** for a cooperative-agent context:
  - **Backslash escapes** — `` `pyth\on script.py` `` (shell resolves `\` to `python`, detector sees `pyth\on`) are not flagged.
  - **Parameter expansion / command substitution** — `$PY script.py`, `$(python ...)`, `command python`, `sudo python`, `env python` are not modeled.
  - **Absolute paths / aliases** — `/usr/bin/python`, `~/bin/python`.
- **No override / allowlist** — there is no way to whitelist a legitimately safe invocation (e.g., a non-Python subproject), so enforcement is binary.
- **No escalation or metrics** — repeated blocks are just repeated toasts; there's no throttle, counter, auto-rewrite, or end-of-session summary.
- **Policy/constraint drift risk** — the teaching strings are hard-coded in the extension rather than read from `AGENTS.md`, so the two documents must be kept in sync manually.

> **Note on evasion-style gaps:** backslash escapes and shell expansion are *deliberate* bypass attempts. This extension is intended as a **policy reminder and safeguard for a cooperative agent** — not a security sandbox. A model that deliberately works around it can always find another escape; hardening against adversarial evasion is out of scope and not worth the complexity.

---

## Suggested future improvements

- Catch the remaining explicit policy patterns: `python -m venv`, `source .../activate`, `pipx`, `$(python ...)`.
- Add an **override / allowlist** mechanism (e.g., a per-path or comment-based opt-out) for mixed-language workspaces.
- Add **repeat-offense escalation** — after N identical blocks, escalate to `terminate: true` or auto-rewrite via `event.input.command` mutation.
- Resolve **backslash escapes** and basic wrappers (`sudo`/`env`/`$(...)`) in the tokenizer — cheap to add, though low real-world value.
- Sweep `write` / `edit` tool content with a non-blocking warning to catch violations at authoring time.

---

## Related files

- `uv-enforce.ts` — the extension source.
- `AGENTS.md` — the written "uv only" policy this extension enforces.

## License / ownership

Project-internal tooling. Not for distribution outside this repository.

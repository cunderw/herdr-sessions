// Past agent sessions on disk: where Claude Code, Codex, omo, omp and pi keep them, a cached index,
// full-text search, the preview, which ones are running now, and bringing one back.
import { agents, appHome, exec, hc, home, notify, readTextFile, run, terminals } from "herdr";
import * as fs from "fs/promises";

const expand = (p) => (p === "~" || p.startsWith("~/") ? home() + p.slice(1) : p);
const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
export const basename = (p) => p.replace(/\/+$/, "").replace(/^.*\//, "") || p;
export const tilde = (p) => {
  const h = home();
  return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const readJson = async (path) => {
  try { return JSON.parse(await readTextFile(path)); } catch { return null; }
};

// One JSON string character: anything but a quote or backslash, or an escape pair.
// Written with plain groups so the same pattern works in rg and in grep -E.
const CH = String.raw`([^"\\]|\\.)`;

// ---- Where the sessions are -----------------------------------------------------------

let located = null;

// omo, omp and pi share one transcript format (pi's): `<agent dir>/sessions/<folder-slug>/
// <time>_<id>.jsonl`, a `session` header with the folder, `message` records, and titles in
// `session_info` (omo, pi) or `title` / `title_change` (omp).
export const PI_LIKE = ["omo", "omp", "pi"];
export const AGENTS = ["claude", "codex", ...PI_LIKE];

// { claude, codex, omo, omp, pi }: each tool's home folder (for omo, omp and pi, the agent
// folder that holds `sessions/`). `sessions.json` in Herdr's home overrides them, else
// $CLAUDE_CONFIG_DIR / $CODEX_HOME / $PI_CODING_AGENT_DIR, else the usual places.
export async function homes() {
  if (located) return located;
  const cfg = (await readJson(`${appHome()}/sessions.json`)) ?? {};
  let env = ["", "", ""];
  try {
    const r = await exec("sh", ["-c", 'printf "%s\\n%s\\n%s" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "$PI_CODING_AGENT_DIR"']);
    env = r.stdout.split("\n");
  } catch {}
  const at = (name, fallback) => expand(cfg[name] ?? fallback).replace(/\/+$/, "");
  located = {
    claude: at("claude", env[0] || "~/.claude"),
    codex: at("codex", env[1] || "~/.codex"),
    omo: at("omo", "~/.omo/agent"),
    omp: at("omp", "~/.omp/agent"),
    pi: at("pi", env[2] || "~/.pi/agent"),
  };
  return located;
}

// Every transcript with its mtime and size, from one `find` and `stat`. Claude Code keeps
// `projects/<folder-slug>/<id>.jsonl` (sub-agents live a level deeper, in `<id>/subagents/`,
// and are left out); Codex keeps `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`; omo, omp
// and pi keep `sessions/<folder-slug>/<time>_<id>.jsonl` (omp's sub-agents live a level
// deeper, in `<time>_<id>/`, and are left out).
async function listFiles(h) {
  // GNU stat takes -c, BSD (macOS) stat takes -f.
  const script = `
    if stat -c %Y / >/dev/null 2>&1; then f=-c; s='%Y %s %n'; else f=-f; s='%m %z %N'; fi
    [ -d "$1" ] && find "$1" -mindepth 2 -maxdepth 2 -name '*.jsonl' -type f -exec stat "$f" "$s" {} +
    echo --codex--
    [ -d "$2" ] && find "$2" -name 'rollout-*.jsonl' -type f -exec stat "$f" "$s" {} +
    for a in omo omp pi; do
      echo "--$a--"; d=$3; shift
      [ -d "$d" ] && find "$d" -mindepth 2 -maxdepth 2 -name '*.jsonl' -type f -exec stat "$f" "$s" {} +
    done
    true`;
  const r = await exec("sh", ["-c", script, "sh", `${h.claude}/projects`, `${h.codex}/sessions`,
    ...PI_LIKE.map((a) => `${h[a]}/sessions`)]);
  const files = [];
  let agent = "claude";
  for (const line of r.stdout.split("\n")) {
    const marker = line.match(/^--([a-z]+)--$/);
    if (marker && AGENTS.includes(marker[1])) { agent = marker[1]; continue; }
    const m = line.match(/^(\d+) (\d+) (.+)$/);
    if (m) files.push({ agent, mtime: Number(m[1]) * 1000, size: Number(m[2]), path: m[3] });
  }
  return files;
}

// ---- Reading the files --------------------------------------------------------------

function unescape(s) {
  try { return JSON.parse(`"${s}"`); } catch {}
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "" })[c] ?? c)
    .replace(/\\u?[0-9a-fA-F]{0,3}$/, "");
}

// What the person typed, or null for what the tool injected as a "user" message
// (tool notifications, hook output, other sessions' messages, environment blocks).
const SKIP = ["Another Claude session", "This session is being continued", "Stop hook feedback",
  "Caveat:", "[Request interrupted", "# AGENTS.md instructions"];
export function cleanPrompt(text) {
  let s = String(text ?? "").replace(/^\s+/, "");
  if (/^<command-(name|message)>/.test(s)) {
    const name = s.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim();
    const args = s.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return name ? { text: args ? `${name} ${args}` : name, command: true } : null;
  }
  const tag = s.match(/^<([a-z_-]+)[\s>]/)?.[1];
  if (tag && tag !== "pasted_content") return null;
  if (SKIP.some((p) => s.startsWith(p))) return null;
  const raw = s;
  s = s.replace(/<\/?pasted_content[^>]*>/g, " ").replace(/^(\[Image[^\]]*\]\s*)+/, "").trim();
  return s ? { text: s, raw, command: false } : null;
}

// A headline for a session with no title of its own: the first sentence of the first prompt,
// from its first line with words, leaving out code blocks, Markdown markers and pasted text
// when there's something else to go on. Slash commands stay as typed (`/review 42`).
export function shortTitle(text) {
  let s = String(text);
  const own = s.replace(/<pasted_content[^>]*>[\s\S]*?(<\/pasted_content>|$)/g, " ");
  if (own.trim()) s = own;
  s = s.replace(/<\/?pasted_content[^>]*>/g, " ").replace(/```[\s\S]*?(```|$)/g, " ");
  const line = s.split("\n").map((l) => l.replace(/^\s*(#+|[-*>]|\d+[.)])\s+/, "").trim()).find(Boolean) ?? "";
  let t = line.match(/^.*?[.?!](?=\s|$)/)?.[0] ?? line;
  if (t.length < 16) t = line; // "Hi." or "Ok." says little; keep the line
  t = t.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 80).replace(/\s+\S*$/, "")}…` : t;
}

// rg when it's installed, grep -E otherwise, with the same patterns. Output lines are
// `path NUL match`. rg must not read ignore files: people keep ~/.claude in git with
// everything ignored, and then rg silently finds nothing.
let hasRg = null;
async function grepFiles(patterns, paths, { max, ignoreCase = false, replace } = {}) {
  if (!paths.length) return [];
  const rgArgs = ["--no-ignore", "--no-config", "--hidden", "--null", "-H", "-N", "-o", "--no-messages"];
  if (max) rgArgs.push("-m", String(max));
  if (ignoreCase) rgArgs.push("-i");
  if (replace) rgArgs.push("-r", replace);
  let r = null;
  if (hasRg !== false) {
    r = await exec("rg", [...rgArgs, ...patterns.flatMap((p) => ["-e", p]), "--", ...paths]).catch(() => null);
    hasRg = r !== null;
  }
  if (!r) {
    const args = ["--null", "-H", "-o", "-E", "-s"];
    if (max) args.push("-m", String(max));
    if (ignoreCase) args.push("-i");
    r = await exec("grep", [...args, ...patterns.flatMap((p) => ["-e", p]), "--", ...paths]);
  }
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const z = line.indexOf("\0");
    if (z > 0) out.push([line.slice(0, z), line.slice(z + 1)]);
  }
  return out;
}

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// A title the person or the tool chose. Claude's `--name` titles that only repeat the
// folder ("api", "api (main)") say nothing the row doesn't, so they don't count.
function chosenTitle(custom, cwd) {
  if (!custom || !cwd) return custom || null;
  const b = basename(cwd);
  return custom === b || custom.startsWith(`${b} (`) ? null : custom;
}

async function indexClaude(files) {
  const found = {};
  for (const f of files) found[f.path] = { ...f, id: basename(f.path).replace(/\.jsonl$/, ""), prompts: [] };
  for (const part of chunks(files.map((f) => f.path), 60)) {
    const [where, said] = await Promise.all([
      // The first record that knows the folder and branch.
      grepFiles([String.raw`"cwd":"[^"]*"`, String.raw`"gitBranch":"[^"]*"`], part, { max: 1 }),
      // Typed prompts (string content) and titles; tool results are arrays and don't match.
      // Title records start their line. `summary` is what older Claude Code versions wrote;
      // anchoring keeps tool inputs with a "summary" key (SendMessage, tasks) out.
      grepFiles([String.raw`"role":"user","content":"${CH}{0,240}`, String.raw`^\{"type":"(ai-title|custom-title|summary)","(aiTitle|customTitle|summary)":"${CH}*"`], part),
    ]);
    for (const [path, m] of where) {
      const s = found[path];
      const c = m.match(/^"cwd":"(.*)"$/), b = m.match(/^"gitBranch":"(.*)"$/);
      if (c && !s.cwd) s.cwd = unescape(c[1]);
      if (b && !s.branch) s.branch = unescape(b[1]);
    }
    for (const [path, m] of said) {
      const s = found[path];
      if (m.startsWith('"role"')) { s.prompts.push(m.slice('"role":"user","content":"'.length)); continue; }
      const t = m.match(/^\{"type":"[a-z-]+","(aiTitle|customTitle|summary)":"(.*)"$/);
      if (t) s[{ aiTitle: "ai", customTitle: "custom", summary: "summary" }[t[1]]] = unescape(t[2]);
    }
  }
  return Object.values(found).map((s) => finish(s, s.ai || chosenTitle(s.custom, s.cwd) || s.summary));
}

async function indexCodex(files, h) {
  const found = {};
  for (const f of files) found[f.path] = { ...f, id: basename(f.path).match(UUID)?.[0] ?? basename(f.path), prompts: [] };
  for (const part of chunks(files.map((f) => f.path), 60)) {
    const [meta, said] = await Promise.all([
      // Line 1 is `session_meta`: the folder, the branch, and who started it.
      grepFiles([String.raw`"cwd":"[^"]*"`, String.raw`"thread_source":"[a-z_]*"`, String.raw`"source":\{"subagent"`, String.raw`"git":\{[^}]*\}`], part, { max: 1 }),
      grepFiles([String.raw`"role":"user","content":\[\{"type":"input_text","text":"${CH}{0,240}`], part),
    ]);
    for (const [path, m] of meta) {
      const s = found[path];
      if (m.startsWith('"cwd"') && !s.cwd) s.cwd = unescape(m.slice(7, -1));
      else if (m.startsWith('"thread_source"')) s.source = m.slice(17, -1);
      else if (m.startsWith('"source"')) s.source = "subagent";
      else if (m.startsWith('"git"')) s.branch = m.match(/"branch":"([^"]*)"/)?.[1] ?? null;
    }
    for (const [path, m] of said) found[path].prompts.push(m.replace(/^.*?"text":"/, ""));
  }
  // Codex's own thread names, newest last.
  const names = {};
  const index = await exec("tail", ["-c", "1000000", `${h.codex}/session_index.jsonl`]).catch(() => null);
  for (const line of index?.stdout.split("\n") ?? []) {
    try { const j = JSON.parse(line); if (j.id && j.thread_name) names[j.id] = j.thread_name; } catch {}
  }
  // Guardian reviews and sub-agents are Codex talking to itself.
  return Object.values(found)
    .map((s) => finish(s, names[s.id] ?? null, s.source && s.source !== "user"));
}

async function indexPi(files) {
  const found = {};
  for (const f of files) found[f.path] = { ...f, id: basename(f.path).match(UUID)?.[0] ?? basename(f.path).replace(/\.jsonl$/, ""), prompts: [] };
  for (const part of chunks(files.map((f) => f.path), 60)) {
    const [heads, said] = await Promise.all([
      // The header and title records are short lines that start with their type.
      grepFiles([String.raw`^\{"type":"(session|session_info|title|title_change)",.*`], part),
      // Typed prompts; tool results have the role `toolResult` and don't match.
      grepFiles([String.raw`"role":"user","content":\[\{"type":"text","text":"${CH}{0,240}`], part),
    ]);
    for (const [path, m] of heads) {
      const s = found[path];
      let j;
      try { j = JSON.parse(m); } catch { continue; }
      if (j.type === "session") {
        if (j.cwd && !s.cwd) s.cwd = j.cwd;
        if (j.id && UUID.test(j.id)) s.id = j.id;
        if (j.title) s.title = j.title;
      } else if (j.type === "session_info" && j.name) s.title = j.name; // the newest wins
      else if (j.title) s.title = j.title;
    }
    for (const [path, m] of said) found[path].prompts.push(m.replace(/^.*?"text":"/, ""));
  }
  return Object.values(found).map((s) => finish(s, chosenTitle(s.title, s.cwd)));
}

// omp prefixes its titles with a Nerd Font glyph, which the UI font doesn't have.
const GLYPHS = /[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/gu;

function finish(s, title, hidden = false) {
  title = title ? title.replace(GLYPHS, "") : title;
  const kept = s.prompts.map((p) => cleanPrompt(unescape(p))).filter(Boolean);
  const first = kept.find((p) => !p.command) ?? kept[0];
  const prompt = first ? first.text.replace(/\s+/g, " ").trim() : "";
  return {
    short: first ? (first.command ? first.text : shortTitle(first.raw.replace(/^(\[Image[^\]]*\]\s*)+/, ""))) : "",
    agent: s.agent, id: s.id, path: s.path, mtime: s.mtime, size: s.size,
    cwd: s.cwd ?? null, branch: s.branch && s.branch !== "HEAD" ? s.branch : null,
    title: title ? title.replace(/\s+/g, " ").trim() : null, prompt, turns: kept.length,
    hidden: hidden || !s.cwd || !kept.length,
  };
}

// ---- The cached list ------------------------------------------------------------------

const CACHE_VERSION = 3;
const cachePath = () => `${appHome()}/data/sessions/index.json`;

export async function cached() {
  const c = await fs.readFile(cachePath(), "utf8").then(JSON.parse).catch(() => null);
  return c?.version === CACHE_VERSION ? c : null;
}

// The list, newest first. Only files that are new or changed since the cache are read.
// Returns { sessions, read, ms }.
export async function load(prev) {
  const t0 = Date.now();
  const h = await homes();
  const files = await listFiles(h);
  const key = AGENTS.map((a) => h[a]).join("|");
  const old = prev?.key === key ? prev.sessions : {};
  const keep = {}, stale = Object.fromEntries(AGENTS.map((a) => [a, []]));
  for (const f of files) {
    const o = old[f.path];
    if (o && o.mtime === f.mtime && o.size === f.size) keep[f.path] = o;
    else stale[f.agent].push(f);
  }
  const fresh = [...(await indexClaude(stale.claude)), ...(await indexCodex(stale.codex, h))];
  for (const a of PI_LIKE) fresh.push(...(await indexPi(stale[a])));
  for (const s of fresh) keep[s.path] = s;
  const read = AGENTS.reduce((n, a) => n + stale[a].length, 0);
  if (read || Object.keys(old).length !== Object.keys(keep).length) {
    await fs.mkdir(dirname(cachePath()), { recursive: true }).catch(() => {});
    await fs.writeFile(cachePath(), JSON.stringify({ version: CACHE_VERSION, key, sessions: keep })).catch(() => {});
  }
  return { sessions: visible(keep), read, ms: Date.now() - t0 };
}

export const visible = (byPath) => Object.values(byPath ?? {}).filter((s) => !s.hidden).sort((a, b) => b.mtime - a.mtime);

// Every word must appear in the title, first prompt, folder, branch or agent.
export function match(list, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => {
    const hay = `${s.title ?? ""} ${s.prompt} ${s.cwd} ${s.branch ?? ""} ${s.agent}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---- Searching inside transcripts -------------------------------------------------------

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The first place in each transcript where the text was said, by the person or the agent:
// typed prompts and text blocks only, never tool calls, hook output or request logs.
// Returns { path: snippet }.
export async function searchText(list, term) {
  // Search for the text as it's written inside a JSON string.
  const t = reEscape(JSON.stringify(term).slice(1, -1));
  const open = String.raw`("role":"user","content":"|"type":"(text|input_text|output_text)","text":"|"type":"(user|agent)_message","message":")`;
  const paths = list.map((s) => s.path);
  const hits = {};
  for (const part of chunks(paths, 400)) {
    let found;
    if (hasRg !== false) {
      // rg keeps the window around the match; its lazy prefix stays inside one string.
      found = await grepFiles([`${open}${CH}*?(?P<hit>${CH}{0,60}${t}${CH}{0,100})`], part, { max: 1, ignoreCase: true, replace: "$hit" });
    }
    if (hasRg === false) {
      // grep has no lazy match or replacement: a plain window around the text.
      found = await grepFiles([`.{0,60}${t}.{0,100}`], part, { max: 1, ignoreCase: true });
    }
    for (const [path, m] of found) hits[path] ??= unescape(m).replace(/\s+/g, " ").trim();
  }
  return hits;
}

// ---- Preview ----------------------------------------------------------------------------

const TAIL = 262144;

// The last exchanges, oldest first: [{ who: "you" | "agent", text }].
export async function preview(s) {
  const r = await exec("tail", ["-c", String(TAIL), s.path]);
  const lines = r.stdout.split("\n");
  if (s.size > TAIL) lines.shift(); // cut mid-record
  const out = [];
  const add = (who, text) => {
    text = String(text ?? "").trim();
    if (!text) return;
    // An agent narrates as it works; its last words in a turn are the answer.
    const last = out[out.length - 1];
    if (who === "agent" && last?.who === "agent") last.text = text;
    else out.push({ who, text });
  };
  const said = (blocks, types) => (Array.isArray(blocks) ? blocks : [])
    .filter((b) => types.includes(b?.type)).map((b) => b.text).join("\n");
  // Replies to what a tool or another session injected as a "user" message are left out
  // with it, so an exchange is always your prompt and the answer to it.
  let skipping = false;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (s.agent === "claude") {
      const m = j.message;
      if (!m || j.isSidechain || j.isMeta) continue;
      if (j.type === "user") {
        const text = typeof m.content === "string" ? m.content : said(m.content, ["text"]);
        if (!text) continue; // a tool result
        const p = cleanPrompt(text);
        skipping = !p;
        if (p) add("you", p.text);
      } else if (j.type === "assistant" && !skipping) add("agent", said(m.content, ["text"]));
    } else if (PI_LIKE.includes(s.agent)) {
      const m = j.message;
      if (j.type !== "message" || !m) continue;
      if (m.role === "user") {
        const c = cleanPrompt(typeof m.content === "string" ? m.content : said(m.content, ["text"]));
        skipping = !c;
        if (c) add("you", c.text);
      } else if (m.role === "assistant" && !skipping) add("agent", said(m.content, ["text"]));
    } else if (j.type === "response_item" && j.payload?.type === "message") {
      const p = j.payload;
      if (p.role === "user") { const c = cleanPrompt(said(p.content, ["input_text"])); skipping = !c; if (c) add("you", c.text); }
      else if (p.role === "assistant" && !skipping) add("agent", said(p.content, ["output_text"]));
    }
  }
  // A long first turn can push the prompt out of the tail; the index still has it.
  if (!out.some((m) => m.who === "you") && s.prompt) out.unshift({ who: "you", text: s.prompt });
  return out.slice(-6);
}

export async function folderExists(path) {
  if (!path) return false;
  const r = await exec("test", ["-d", path]).catch(() => null);
  return r?.code === 0;
}

// ---- Running now --------------------------------------------------------------------------

// The session id a command line resumes: `claude --resume <id>`, `claude -r <id>`,
// `claude --session-id <id>`, `codex resume <id>`, `omp --resume <id|file>`,
// `omo --session <file>`, `pi --session <id|file>` (file names carry the id).
export function resumedId(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.match(/^--(resume|session-id|session)=(.+)$/);
    if (eq && UUID.test(eq[2])) return eq[2].match(UUID)[0];
    if (["--resume", "-r", "--session-id", "--session", "resume"].includes(a) && UUID.test(argv[i + 1] ?? "")) return String(argv[i + 1]).match(UUID)[0];
  }
  return null;
}

// Which of the five tools an agent terminal runs, or null.
export function harnessOf(a) {
  if (a.app === "claude-code") return "claude";
  for (const k of [a.program?.key, a.app]) if (AGENTS.includes(k)) return k;
  return null;
}

// omo writes `sessions/<slug>/session-holders/<id>/<pid>.json` for each running session.
async function omoHolders(h) {
  const r = await exec("find", [`${h.omo}/sessions`, "-mindepth", "4", "-maxdepth", "4", "-path", "*/session-holders/*", "-name", "*.json"]).catch(() => null);
  const byPid = {};
  for (const p of r?.stdout.split("\n") ?? []) {
    const m = p.match(/session-holders\/([^/]+)\/(\d+)\.json$/);
    if (m) byPid[m[2]] = m[1];
  }
  return byPid;
}

// omp writes `terminal-sessions/<tty>`: the folder, then the session file it has open.
async function ompSession(h, pid) {
  const r = await exec("ps", ["-o", "tty=", "-p", String(pid)]).catch(() => null);
  const tty = r?.stdout.trim();
  if (!tty || tty.startsWith("?")) return null;
  const text = await readTextFile(`${h.omp}/terminal-sessions/${tty}`).catch(() => null);
  return text?.split("\n")[1]?.match(UUID)?.[0] ?? null;
}

// { id: { terminal, status, where } } for the sessions running in a Herdr terminal on this
// machine. Claude Code writes `<claude home>/sessions/<pid>.json` with its current session
// id; the terminal's foreground process gives the pid. A session started with a resume
// command is known from its arguments.
export async function live() {
  const h = await homes();
  const byAddress = Object.fromEntries(terminals().map((t) => [t.address, t]));
  const out = {};
  const local = agents().filter((a) => !a.address.includes("/"));
  const holders = local.some((a) => harnessOf(a) === "omo") ? await omoHolders(h) : {};
  await Promise.all(local.map(async (a) => {
    let fg = byAddress[a.address]?.foreground;
    if (!fg) {
      const r = await hc(["get", a.address, "--json"]).catch(() => null);
      try { fg = JSON.parse(r.stdout).foreground; } catch {}
    }
    if (!fg) return;
    let id = resumedId(fg.argv ?? []);
    const tool = harnessOf(a);
    if (fg.pid && tool === "claude") {
      id = (await readJson(`${h.claude}/sessions/${fg.pid}.json`))?.sessionId ?? id;
    } else if (fg.pid && tool === "omo") {
      id = holders[fg.pid] ?? id;
    } else if (fg.pid && tool === "omp") {
      id = (await ompSession(h, fg.pid)) ?? id;
    }
    if (id) out[id] = { terminal: a.address, status: a.status, where: `${a.space_name} / ${a.tab_name}` };
  }));
  return out;
}

// ---- Bringing one back ----------------------------------------------------------------------

// fork: a new session that starts from this one's history; the original is left as it was.
// null when the tool can't fork from its command line (omo, omp).
export function command(s, fork = false) {
  switch (s.agent) {
    case "claude": return ["claude", "--resume", s.id, ...(fork ? ["--fork-session"] : [])];
    case "codex": return ["codex", fork ? "fork" : "resume", s.id];
    case "omo": return fork ? null : ["omo", "--session", s.path];
    case "omp": return fork ? null : ["omp", "--resume", s.path];
    case "pi": return ["pi", fork ? "--fork" : "--session", s.path];
  }
  return null;
}
export const canFork = (s) => command(s, true) !== null;
// The row's project: the folder's name, or ~ for the home folder.
export const project = (s) => (!s.cwd ? "?" : tilde(s.cwd) === "~" ? "~" : basename(s.cwd));
const NAMES = { claude: "Claude Code", codex: "Codex", omo: "OMO", omp: "OMP", pi: "pi" };
export const agentName = (s) => NAMES[s.agent] ?? s.agent;
export const headline = (s) => s.title || s.short || s.prompt || s.id;

export function tabName(s) {
  const t = headline(s);
  return t.length > 32 ? `${t.slice(0, 31).trimEnd()}…` : t;
}

// place: "tab" or "right".
export function resume(s, place, fork = false) {
  const args = { argv: command(s, fork), folder: s.cwd, place };
  if (place === "tab") args.name = fork ? `fork: ${tabName(s)}` : tabName(s);
  run("terminal.open", args);
}

// gpui-kit's own clipboard: the same on macOS, Linux and Windows, no pbcopy or wl-copy.
export function copy(cx, text) {
  cx.write_to_clipboard(text);
  notify({ title: "Session id copied", body: text, level: "success", timeout: 2500 });
}

// ---- Sending to an agent ---------------------------------------------------------------------

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// What goes into the agent's prompt: a header naming the session, then each message.
export function quote(s, items) {
  const who = (m) => (m.who === "you" ? "You" : agentName(s));
  const body = items.map((m) => `${who(m)}: ${m.text.trim()}`).join("\n\n");
  return `From a past session (${headline(s)}, ${day(s.mtime)}):\n\n${body}\n`;
}

// The last exchange: your last prompt and what the agent said after it.
export function lastExchange(items) {
  const i = items.map((m) => m.who).lastIndexOf("you");
  return i < 0 ? items.slice(-1) : items.slice(i);
}

// Puts text into a terminal's prompt without pressing Enter. hc has no raw paste (`hc send`
// wraps the text in <hc> tags and submits it; `hc keys` takes key names), so the text goes
// on the clipboard and Herdr's `terminal.paste` pastes it into the focused terminal as one
// bracketed paste, which agents take as a single paste however many lines it has.
// `terminal.paste` takes no target, hence the `pane.focus` first. The clipboard's text is
// put back 400ms later, unless the person copied something else meanwhile. `cx` must be a
// spawned task's: it is used after an await.
export async function pasteInto(cx, terminal, text) {
  const before = cx.read_from_clipboard();
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal });
  run("terminal.paste");
  await cx.sleep(400);
  if (before !== undefined && cx.read_from_clipboard() === text) cx.write_to_clipboard(before);
}

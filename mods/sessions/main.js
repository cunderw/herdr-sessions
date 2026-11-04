// Agent sessions for Herdr: a popup that finds any past Claude Code or Codex session by
// what was said in it, previews it, and brings it back in a new tab or a split, or shows
// it if it's running now.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, closeOverlay, focused, nextCommand, notify, panes, props, run, settings, theme } from "herdr";
import * as data from "./sessions.js";

const ICON = (name) => `mods/sessions/${name}.svg`;
const AGENT_ICON = { claude: "icons/claude.svg", codex: "icons/codex.svg" };
const ROW = 50;
const WINDOW = 9;

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  const d = new Date(ms), now = new Date();
  const month = MONTHS[d.getMonth()];
  return d.getFullYear() === now.getFullYear() ? `${month} ${d.getDate()}` : `${month} ${d.getFullYear()}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// on_size_change reports sizes with the app's zoom applied; layout values are unzoomed.
const unzoom = (px) => px / (Number(settings()?.zoom) || 1);

// The terminal the popup was opened over: where "Send" pastes. Mod panes have none.
function sendTarget() {
  const terminal = focused()?.terminal;
  if (!terminal) return null;
  const a = agents().find((x) => x.address === terminal);
  const pane = panes().find((p) => p.terminal === terminal);
  return { terminal, name: a?.program?.name ?? pane?.program?.name ?? "terminal", agent: Boolean(a) };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export default class Sessions extends View {
  init(_props, cx) {
    this.query = "";
    this.at = 0;
    this.all = null;   // every session, newest first
    this.rows = null;  // what the query shows
    this.hits = {};    // path -> matching text, in transcript search
    this.liveIds = {};
    this.previews = {};
    this.n = 0;
    this.target = sendTarget();
    this.input = InputState.new({ placeholder: "Find a session…   /text searches what was said" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; this.update(cx); });
    this.input.on("submit", (e, cx) => this.submit(e?.secondary ? "copy" : e?.shift ? "right" : "tab", cx));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        const cache = await data.cached();
        if (cache) { this.all = data.visible(cache.sessions); this.update(cx); }
        this.liveIds = await data.live().catch(() => ({}));
        this.all = (await data.load(cache)).sessions;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.update(cx);
    });
    // Agents start and stop while the popup is open.
    cx.timer.every(4000, (cx) => {
      cx.spawn(async (cx) => {
        const next = await data.live().catch(() => null);
        if (next && JSON.stringify(next) !== JSON.stringify(this.liveIds)) { this.liveIds = next; cx.notify(); }
      });
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "next") this.move(1, cx);
        else if (c === "prev") this.move(-1, cx);
        else if (c === "copy") this.submit("copy", cx);
        else if (c === "split") this.submit("right", cx);
        else if (c === "fork") this.submit("fork", cx);
        else if (c === "send") this.sendLast(cx);
        else continue;
        cx.notify();
      }
    });
  }

  // How many rows fit the list's measured height (the popup shrinks in a short window).
  fit() {
    return this.listH ? Math.max(1, Math.floor((this.listH + 2) / (ROW + 2))) : WINDOW;
  }

  textMode() {
    return this.query.startsWith("/");
  }

  // Filtering by title and folder is instant; transcript search waits for typing to pause.
  update(cx) {
    const n = ++this.n, q = this.query;
    if (!this.all) return cx.notify();
    if (!this.textMode()) {
      this.hits = {};
      this.searching = false;
      this.rows = data.match(this.all, q);
      this.select(cx);
      return cx.notify();
    }
    const term = q.slice(1).trim();
    if (!term) { this.rows = []; this.hits = {}; return cx.notify(); }
    this.searching = true;
    cx.notify();
    cx.timer.after(180, (cx) => {
      if (n !== this.n) return;
      cx.spawn(async (cx) => {
        try {
          const hits = await data.searchText(this.all, term);
          if (n !== this.n) return;
          this.hits = hits;
          this.rows = this.all.filter((s) => hits[s.path] !== undefined);
          this.error = null;
        } catch (e) { if (n === this.n) this.error = String(e?.message ?? e); }
        this.searching = false;
        this.select(cx);
        cx.notify();
      });
    });
  }

  current() {
    return this.rows?.[this.at] ?? null;
  }

  move(step, cx) {
    const count = this.rows?.length ?? 0;
    if (!count) return;
    this.at = (this.at + step + count) % count;
    this.select(cx);
  }

  // Loads the selected session's preview once the selection rests.
  select(cx) {
    const s = this.current();
    if (!s || this.previews[s.path]?.mtime === s.mtime) return;
    const n = (this.selN = (this.selN ?? 0) + 1);
    cx.timer.after(90, (cx) => {
      if (n !== this.selN) return;
      cx.spawn(async (cx) => {
        const items = await data.preview(s).catch(() => null);
        this.previews[s.path] = { mtime: s.mtime, items };
        cx.notify();
      });
    });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  // how: "tab", "right", "fork" (a new tab branching from the session) or "copy".
  submit(how, cx) {
    const s = this.current();
    if (!s || this.twice(how)) return;
    if (how === "copy") { data.copy(cx, s.id); return this.close(); }
    const live = this.liveIds[s.id];
    // A fork starts a new session, so a running original doesn't stop it.
    if (live && how !== "fork") { this.close(); return run("agent.focus", { terminal: live.terminal }); }
    cx.spawn(async () => {
      // Worktrees and scratch folders come and go; the agent can't resume outside its folder.
      if (!(await data.folderExists(s.cwd))) {
        return notify({ title: "That session's folder is gone", body: `${data.tilde(s.cwd ?? "?")} no longer exists. Recreate it, then run: ${data.command(s).join(" ")}`, level: "error" });
      }
      this.close();
      data.resume(s, how === "fork" ? "tab" : how, how === "fork");
    });
  }

  // A key bound in keys.json may also reach on_key_down; act once.
  twice(what) {
    const now = Date.now(), dup = this.lastAct?.what === what && now - this.lastAct.at < 400;
    this.lastAct = { what, at: now };
    return dup;
  }

  // Pastes messages from the selected session into the agent that had focus when the popup
  // opened, without sending them.
  send(items, cx) {
    const s = this.current();
    if (!s || !items?.length || this.twice("send")) return;
    if (!this.target) return notify({ title: "No terminal to send to", body: "Focus an agent's pane, then open sessions again.", level: "warning", timeout: 3000 });
    const text = data.quote(s, items), terminal = this.target.terminal;
    // The popup closes after the clipboard is put back: closing it cancels its tasks.
    cx.spawn(async (cx) => { await data.pasteInto(cx, terminal, text); this.close(); });
  }

  sendLast(cx) {
    const items = this.previews[this.current()?.path]?.items;
    if (items?.length) this.send(data.lastExchange(items), cx);
  }

  key(e, cx) {
    const m = e.modifiers;
    if (e.key === "escape") return this.close();
    if (e.key === "down" || (m.control && e.key === "n")) this.move(1, cx);
    else if (e.key === "up" || (m.control && e.key === "p")) this.move(-1, cx);
    else if (e.key === "pagedown") this.move(Math.min(this.fit(), (this.rows?.length ?? 1) - 1 - this.at) || 0, cx);
    else if (e.key === "pageup") this.move(-Math.min(this.fit(), this.at), cx);
    else if (m.control && e.key === "o") this.submit("fork", cx);
    else if (m.control && e.key === "s") this.sendLast(cx);
    else if (e.key === "tab") {
      // Tab flips between filtering the list and searching inside transcripts.
      const next = this.textMode() ? this.query.slice(1) : `/${this.query}`;
      this.input.set_value(next);
      this.query = next; this.at = 0; this.update(cx);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  agentIcon(s, size = 16) {
    return image(AGENT_ICON[s.agent]).size(size).flex_none().rounded(4);
  }

  row(s, index, t) {
    const live = this.liveIds[s.id];
    const hit = this.hits[s.path];
    const project = data.project(s);
    const detail = hit !== undefined ? `${project} · ${hit}` : [project, s.branch].filter(Boolean).join(" · ");
    return h_flex().id(`row-${s.path}`).h(ROW).flex_none().px(10).gap(10).items_center().rounded(7).cursor_pointer()
      .when(index === this.at, (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover))
      .on_click((e, cx) => {
        if (this.at !== index) { this.at = index; this.select(cx); cx.notify(); return; }
        this.submit(e.modifiers.platform || e.modifiers.control ? "copy" : e.modifiers.shift ? "right" : "tab", cx);
      })
      .child(this.agentIcon(s))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_color(t.foreground).child(data.headline(s)))
        .child(div().truncate().text_size(12).text_color(hit !== undefined ? t.muted : t.dim).child(detail)))
      .child(v_flex().flex_none().items_end().gap(3)
        .child(h_flex().gap(6).items_center()
          .when(Boolean(live), (el) => el.child(div().size(7).rounded(4).bg(t[live.status] ?? t.working)))
          .child(div().text_size(12).text_color(live ? t.foreground : t.muted).child(live ? "live" : ago(s.mtime))))
        .child(div().text_size(11).text_color(t.dim).child(`${s.turns} ${s.turns === 1 ? "turn" : "turns"}`)));
  }

  previewPane(t) {
    const s = this.current();
    if (!s) return v_flex().flex_1().min_w(0);
    const live = this.liveIds[s.id];
    const p = this.previews[s.path];
    const meta = (icon, text, color = t.muted) => h_flex().gap(7).items_center().min_w(0)
      .child(svg(ICON(icon)).size(13).flex_none().text_color(t.dim))
      .child(div().truncate().text_size(12).text_color(color).child(text));
    const items = p?.items ?? [];
    return v_flex().flex_1().min_w(0).h_full().min_h(0).gap(10).pl(14).border_l_1().border_color(t.border)
      .child(v_flex().gap(6).flex_none()
        .child(h_flex().gap(8).items_center()
          .child(this.agentIcon(s, 18))
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(data.headline(s))))
        .when(Boolean(s.prompt && data.headline(s) !== s.prompt), (el) =>
          el.child(div().text_size(12).text_color(t.muted).child(clip(s.prompt, 160))))
        .child(meta("folder", data.tilde(s.cwd ?? "?")))
        .when(Boolean(s.branch), (el) => el.child(meta("git-branch", s.branch)))
        .child(meta("clock", `${data.agentName(s)} · ${ago(s.mtime) === "now" ? "just now" : `${ago(s.mtime)} ago`} · ${s.turns} ${s.turns === 1 ? "turn" : "turns"}`))
        .child(meta("hash", s.id, t.dim))
        .when(Boolean(live), (el) => el.child(h_flex().gap(7).items_center()
          .child(div().size(8).rounded(4).flex_none().bg(t[live.status] ?? t.working))
          .child(div().truncate().text_size(12).text_color(t.foreground).child(`Running in ${live.where} · ${live.status}`)))))
      .child(h_flex().gap(6).flex_none().items_center()
        .child(this.button("act-resume", live ? "Show" : "Resume", t, (cx) => this.submit("tab", cx)))
        .child(this.button("act-fork", "Fork", t, (cx) => this.submit("fork", cx)))
        .child(this.button("act-send", this.target ? `Send to ${this.target.name}` : "Send", t, (cx) => this.sendLast(cx), !this.target || !items.length))
        .child(this.button("act-copy", "Copy id", t, (cx) => this.submit("copy", cx))))
      .child(div().h(1).flex_none().bg(t.border))
      .when(!items.length, (el) => el.child(div().text_size(12).text_color(t.dim).child(p ? "Nothing to preview" : "Loading…")))
      .child(v_flex().id("exchanges").flex_1().min_h(0).gap(10).overflow_hidden()
        .on_size_change((size, cx) => { const h = unzoom(size.height), w = unzoom(size.width); if (h !== this.pvH || w !== this.pvW) { this.pvH = h; this.pvW = w; cx.notify(); } })
        .children(this.fitting(items).map((m, i) => v_flex().id(`msg-${i}`).gap(3).flex_none()
          .child(h_flex().justify_between().items_center()
            .child(div().text_size(11).font_semibold().text_color(m.who === "you" ? t.accent : t.muted)
              .child(m.who === "you" ? "YOU" : data.agentName(s).toUpperCase()))
            .when(Boolean(this.target), (el) => el.child(div().id(`send-${i}`).px(6).rounded(4).text_size(11).text_color(t.dim).cursor_pointer()
              .hover((x) => x.text_color(t.accent).bg(t.hover))
              .on_click((_e, cx) => this.send([m.src], cx))
              .child("Send"))))
          .child(div().text_size(12.5).text_color(m.who === "you" ? t.foreground : t.muted).child(m.text)))));
  }

  button(id, label, t, act, disabled = false) {
    return h_flex().id(id).h(24).px(9).flex_none().items_center().rounded(6).border_1().border_color(t.border)
      .text_size(12).text_color(disabled ? t.dim : t.foreground)
      .when(!disabled, (el) => el.cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => act(cx)))
      .child(label);
  }

  // The newest exchanges that fit the preview's measured size, oldest first. Line counts
  // are estimated from the width, so the newest one is never the one cut off.
  fitting(items) {
    const perLine = Math.max(20, Math.floor((this.pvW || 420) / 6.6));
    const lines = (text) => text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    let room = (this.pvH || 300) - 2;
    const out = [];
    for (const m of items.slice().reverse()) {
      let text = clip(m.text.replace(/\n{3,}/g, "\n\n"), m.who === "you" ? 280 : 420);
      const need = 17 + lines(text) * 18 + 10;
      if (need > room) {
        if (out.length) break;
        // The newest alone is too tall: show as much of it as fits.
        text = clip(text, Math.max(40, Math.floor((room - 27) / 18) * perLine));
      }
      out.unshift({ who: m.who, text, src: m });
      room -= need;
    }
    return out;
  }

  render() {
    const t = theme(), rows = this.rows ?? [], text = this.textMode();
    const fit = this.fit();
    const first = Math.max(0, Math.min(this.at - Math.floor(fit / 2), rows.length - fit));
    const shown = rows.slice(first, first + fit);
    const status = this.error ?? (this.rows === null ? "Reading sessions…"
      : this.searching && !rows.length ? "Searching transcripts…"
      : rows.length ? null
      : text ? (this.query.slice(1).trim() ? "Nobody said that" : "Type to search what was said in every session")
      : this.all?.length ? "No sessions match" : "No Claude Code or Codex sessions found");
    const live = Object.keys(this.liveIds).length;
    const footer = "Enter resume · Shift+Enter split · Ctrl+O fork · Ctrl+S send last exchange · ⌘/Ctrl+Enter copy id · Tab search transcripts";
    // A popup sizes to its content, so the height is set here and stays put while typing.
    return v_flex().id("sessions").w_full().h(560).min_h(0).p(14).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().justify_between().items_center()
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child(text ? "Search transcripts" : "Sessions"))
          .when(live > 0, (el) => el.child(div().text_size(12).text_color(t.dim).child(`${live} live`))))
        .child(div().text_size(12).text_color(t.muted).child(this.all ? `${rows.length} of ${this.all.length}` : "")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.raised)
        .child(svg(ICON(text ? "text-search" : "search")).size(14).flex_none().text_color(t.muted))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(h_flex().flex_1().min_h(0).items_start().gap(0)
        .child(v_flex().id("list").w(450).flex_none().h_full().min_h(0).gap(2).pr(10).overflow_hidden()
          .on_size_change((size, cx) => { const h = unzoom(size.height); if (h !== this.listH) { this.listH = h; cx.notify(); } })
          .on_scroll_wheel((e, cx) => {
            // Trackpads send many small deltas: move a row per row's height scrolled.
            this.wheel = (this.wheel ?? 0) + (e.delta_lines ? e.delta_lines.y : e.delta.y / ROW);
            const steps = Math.trunc(this.wheel);
            if (steps) { this.wheel -= steps; this.move(-steps, cx); cx.notify(); }
          })
          .when(Boolean(status), (el) => el.child(div().p(8).text_color(this.error ? t.blocked : t.muted).child(status ?? "")))
          .children(shown.map((s, i) => this.row(s, first + i, t))))
        .child(this.previewPane(t)))
      .child(div().flex_none().truncate().text_size(12).text_color(t.dim).child(footer));
  }
}

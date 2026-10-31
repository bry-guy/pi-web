import { api, openTranscript, refreshState } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { setHTML, store } from "./store.js";
import { closeConversation, esc, isDraft, icon, mobile, newChat, newProjectSession, selectChat, selectSession } from "./shell.js";

let pendingMessageSequence = 0;
const copyButton = (side, replies = 1) => {
  const tip = side === "user" ? "Copy Message" : "Copy Response";
  const one = `<button class="msg-action" type="button" data-copy data-tip="${tip}" aria-label="${tip}">${icon("copy")}</button>`;
  const turn = replies > 1 ? `<button class="msg-action" type="button" data-copy data-copy-turn data-tip="Copy Turn" aria-label="Copy Turn (${replies} replies)">${icon("copyTurn")}</button>` : "";
  return `<div class="msg-actions ${side}">${one}${turn}</div>`;
};
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LIVE_AGENT_STATUSES = new Set(["running", "queued"]);
const HISTORY_PAGE_SIZE = 500;
// Per-tab reading position: the first visible record and its offset, or "at bottom".
const scrollKey = id => `pi-ez-web:scroll:${id}`;
function savedScroll(id) {
  try { return JSON.parse(globalThis.sessionStorage?.getItem(scrollKey(id)) || "null"); } catch { return null; }
}
const agentRecord = record => record?.role === "activity" && record.kind === "agent";
const liveAgent = record => agentRecord(record) && LIVE_AGENT_STATUSES.has(record.status);
const agentRunId = record => record?.runId || String(record?.id || record?.key || "agent").replace(/^activity:agent:/, "");
const agentGroupId = record => record?.groupId || record?.parentMessageId || "ungrouped";
function elapsedAgent(record) {
  const start = Date.parse(String(record?.startedAt || record?.createdAt || ""));
  if (!Number.isFinite(start)) return "";
  const end = Date.parse(String(record?.endedAt || ""));
  const duration = Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start);
  if (duration < 1000) return `${Math.round(duration)}ms`;
  return `${(duration / 1000).toFixed(1)}s`;
}
function agentStatusGlyph(status) {
  return status === "queued" ? "○" : "◐";
}

/* ---------------- chat activity ---------------- */
// Pi's braille spinner frames, drawn as a 2×3 dot grid. The frames use only
// braille dots 1–6, so the cell's fourth row (dots 7 and 8) is not drawn.
const BRAILLE_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const BRAILLE_CELLS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20]; // row-major, two columns
const SPINNER_MS = 80;
let spinnerFrame = 0;
let spinnerTimer = null;
const reducedMotion = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
function dotGrid(frame) {
  const bits = BRAILLE_FRAMES.charCodeAt(frame) - 0x2800;
  return BRAILLE_CELLS.map(bit => `<i${bits & bit ? ' class="on"' : ""}></i>`).join("");
}
function startSpinners() {
  if (spinnerTimer || reducedMotion()) return;
  spinnerTimer = setInterval(() => {
    const grids = globalThis.document?.querySelectorAll("[data-busy-dots]") || [];
    if (!grids.length) { clearInterval(spinnerTimer); spinnerTimer = null; return; }
    spinnerFrame = (spinnerFrame + 1) % BRAILLE_FRAMES.length;
    for (const grid of grids) grid.innerHTML = dotGrid(spinnerFrame);
  }, SPINNER_MS);
  spinnerTimer.unref?.();
}
const clip = (text, max = 60) => {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const workedFor = ms => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const stepsHash = turnId => `#steps=${encodeURIComponent(turnId)}`;

/* ---------------- turns ---------------- */
// A turn is a user record and everything recorded until the next user record.
function turnsOf(records) {
  const turns = [];
  for (const record of records) {
    if (record.role === "user") turns.push({ user: record, records: [] });
    else turns.at(-1)?.records.push(record);
  }
  return turns;
}
// Per turn, only its last reply text gets the copy row; earlier replies sit closer together.
// Map: reply id -> { final, replies }. The running turn has no final reply yet.
function replyLayout(turns, streaming) {
  const layout = new Map();
  turns.forEach((turn, index) => {
    const replies = turn.records.filter(record => record.role === "assistant" && record.text);
    const running = streaming && index === turns.length - 1;
    replies.forEach((record, i) => layout.set(record.id, { final: !running && i === replies.length - 1, replies: replies.length }));
  });
  return layout;
}
const turnKey = turn => turn.user.id ?? turn.user.pendingId ?? "";
function turnStats(turn) {
  const start = Number(turn.user.at) || 0;
  const end = Math.max(start, ...turn.records.map(record => Number(record.at) || 0));
  const duration = start && end > start ? end - start : 0;
  return { steps: turn.records.filter(record => record.role === "tool").length, duration: duration >= 1000 ? duration : 0 };
}


/* ---------------- thread ---------------- */
const EMPTY_STATE = `<div class="empty-pi"><div class="tile">π</div><h1 class="empty-greeting">What shall we <em>build</em>?</h1></div>`;

class PiThread extends HTMLElement {
  connectedCallback() {
    this.renderCache = new WeakMap();
    // Follow streaming output only while the reader stays at the bottom; any upward scroll stops it.
    this.follow = true;
    this.onTouch = e => { this.touching = e.type === "touchstart"; };
    this.onScroll = () => {
      const scroller = this.scroller;
      if (!scroller) return;
      const top = scroller.scrollTop;
      if (top < (this.lastTop ?? top) - 1) this.follow = false;
      else if (scroller.scrollHeight - top - scroller.clientHeight < 24) this.follow = true;
      this.lastTop = top;
      if (this.inSteps) return;
      if (!this.scrollSaveFrame) this.scrollSaveFrame = requestAnimationFrame(() => { this.scrollSaveFrame = 0; this.saveScroll(); });
      if (scroller.scrollTop > 360) return;
      this.loadEarlier();
    };
    this.bindScroller();
    this.onPopState = () => this.syncSteps();
    window.addEventListener("popstate", this.onPopState);
    this.unsub = store.subscribe(w => {
      // Tool and turn events can arrive many per frame; render once per frame instead of once per event.
      if (w === "state") this.render();
      else if (w === "transcript") this.scheduleRender();
      else if (w === "delta:" + store.activeKey()) this.applyDelta();
      else if (w === "thinking:" + store.activeKey() && this.inSteps) this.render();
    });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-toggle], [data-activity-toggle]")) {
        e.preventDefault(); e.target.closest("[data-toggle], [data-activity-toggle]").click();
      }
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    window.removeEventListener("popstate", this.onPopState);
    for (const type of ["scroll", "touchstart", "touchend", "touchcancel"]) this.scroller?.removeEventListener(type, type === "scroll" ? this.onScroll : this.onTouch);
  }

  bindScroller() {
    const scroller = this.closest(".scrollable");
    if (scroller === this.scroller) return;
    for (const [type, fn] of [["scroll", this.onScroll], ["touchstart", this.onTouch], ["touchend", this.onTouch], ["touchcancel", this.onTouch]]) {
      this.scroller?.removeEventListener(type, fn);
      scroller?.addEventListener(type, fn, { passive: true });
    }
    this.scroller = scroller;
  }

  async onClick(e) {
    const copy = e.target.closest("[data-copy]");
    if (copy) { void this.copyMessage(copy); return; }
    // Touch has no hover: tapping your own message reveals its copy button.
    const reveal = e.target.closest("[data-copy-reveal]");
    if (reveal && !e.target.closest("a, button")) {
      const row = reveal.closest(".msg");
      this.querySelectorAll(".msg.show-actions").forEach(el => { if (el !== row) el.classList.remove("show-actions"); });
      row?.classList.toggle("show-actions");
    }
    if (e.target.closest("[data-act='clear-queue']")) {
      api.clearQueue(store.activeKey()).catch(err => store.setError(`Cancel failed: ${err.message || err}`));
      return;
    }
    const stepsOpen = e.target.closest("[data-steps-open]");
    if (stepsOpen) { this.openSteps(stepsOpen.dataset.stepsOpen); return; }
    if (e.target.closest("[data-steps-back]")) { this.closeSteps(); return; }
    const activityToggle = e.target.closest("[data-activity-toggle]");
    if (activityToggle) {
      const key = activityToggle.dataset.activityToggle;
      const open = store.state.openActivity[key] ?? false;
      store.state.openActivity[key] = !open;
      this.render();
      return;
    }
    const tog = e.target.closest("[data-toggle]");
    if (tog) {
      const id = tog.dataset.toggle;
      store.state.openTools[id] = !this.isOpen(id);
      this.render();
    }
  }

  isOpen(id) { return store.state.openTools[id] ?? false; }

  applyDelta() {
    if (this.deltaFrame !== undefined) return;
    const now = globalThis.performance?.now?.() || Date.now();
    const elapsed = now - (this.lastDeltaRender || 0);
    if (elapsed < 32) {
      const run = () => { this.deltaFrame = undefined; this.applyDeltaNow(); };
      this.deltaFrame = globalThis.requestAnimationFrame ? requestAnimationFrame(run) : setTimeout(run, 32 - elapsed);
      return;
    }
    this.applyDeltaNow();
  }

  applyDeltaNow() {
    this.lastDeltaRender = globalThis.performance?.now?.() || Date.now();
    const holder = this.querySelector("[data-live-text]");
    const recs = store.transcript().records;
    const last = [...recs].reverse().find(r => r.role === "assistant" && r.streaming);
    if (!holder || !last) return this.render();
    const body = holder.querySelector(".markdown-content");
    if (!body) return this.render();
    body.innerHTML = renderMarkdown(last.text);
    this.__html = null; // streamed text changed the DOM outside render()
    this.autoscroll();
  }

  autoscroll(force = false) {
    const sc = this.closest(".scrollable") || this;
    if (!force && (!this.follow || this.touching)) return;
    this.follow = true;
    sc.scrollTop = sc.scrollHeight;
    this.lastTop = sc.scrollTop;
    if (force) {
      const raf = globalThis.requestAnimationFrame || this.ownerDocument?.defaultView?.requestAnimationFrame?.bind(this.ownerDocument.defaultView);
      raf?.(() => { if (this.isConnected) sc.scrollTop = sc.scrollHeight; });
    }
  }

  saveScroll() {
    const id = this.renderedKey;
    const scroller = this.scroller;
    if (!id || !scroller || this.restoring) return;
    const recs = this.querySelectorAll("[data-rec]");
    if (!recs.length) return;
    const value = this.scrollAnchor();
    try { globalThis.sessionStorage?.setItem(scrollKey(id), JSON.stringify(value)); } catch { /* storage is optional */ }
  }

  /** Where the reader is: at the bottom, or which record sits at the top of the view. */
  scrollAnchor() {
    const scroller = this.scroller;
    const recs = this.querySelectorAll("[data-rec]");
    if (!scroller || !recs.length || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160) return { bottom: true };
    const top = scroller.getBoundingClientRect().top;
    const el = [...recs].find(node => node.getBoundingClientRect().bottom > top) || recs[recs.length - 1];
    return { rec: el.dataset.rec, offset: Math.round(el.getBoundingClientRect().top - top) };
  }

  restoreScroll(saved) {
    const scroller = this.scroller || this.closest(".scrollable");
    const el = [...this.querySelectorAll("[data-rec]")].find(node => node.dataset.rec === saved.rec);
    if (!scroller || !el) return false;
    const apply = () => {
      if (!el.isConnected) return;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (saved.offset || 0);
    };
    this.restoring = true;
    apply();
    // Late layout (fonts, code blocks) can shift the anchor; settle it next frame.
    requestAnimationFrame(() => { apply(); this.restoring = false; });
    return true;
  }

  loadEarlier() {
    if (this.historyLoading || !this.hasEarlier()) return;
    const scroller = this.scroller || this.closest(".scrollable") || this;
    const beforeHeight = scroller.scrollHeight;
    const beforeTop = scroller.scrollTop;
    this.historyLoading = true;
    this.historyLimit += HISTORY_PAGE_SIZE;
    this.render();
    scroller.scrollTop = beforeTop + scroller.scrollHeight - beforeHeight;
    this.historyLoading = false;
  }

  visibleRecords(records) {
    // Running agents stay in the live activity surface. Once a run reaches a
    // terminal state, its compact record returns to the transcript at the
    // point where the work was recorded, so the live surface does not grow
    // forever.
    return records.filter(record => record.role !== "activity"
      || record.key === "compaction"
      || record.kind !== "agent"
      || !liveAgent(record));
  }

  hasEarlier() {
    const id = store.activeKey();
    const transcript = id && (store.state.transcripts[id] || store.transcript(id));
    return !!transcript && this.historyRecords(this.visibleRecords(transcript.records)).hasEarlier;
  }

  historyRecords(records) {
    const limit = this.historyLimit || HISTORY_PAGE_SIZE;
    if (records.length <= limit) return { records, hasEarlier: false };
    const keep = new Set(records.slice(-limit));
    for (const record of records) {
      if (record.role === "activity" || record.pending || record.deliveryError || record.streaming) keep.add(record);
    }
    const selected = records.filter(record => keep.has(record));
    return { records: selected, hasEarlier: selected.length < records.length };
  }

  scheduleRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : callback => setTimeout(callback, 16);
    frame(() => { if (this.renderQueued) { this.renderQueued = false; this.render(); } });
  }

  render() {
    this.renderQueued = false; // a synchronous render covers any queued one
    const activeKey = store.activeKey();
    const t = activeKey ? (store.state.transcripts[activeKey] || store.transcript(activeKey)) : null;
    let anchor = null;
    if (activeKey !== this.renderedKey || t !== this.renderedTranscript) {
      // A background reload of the open transcript keeps the reader where they are.
      const background = activeKey === this.renderedKey && t?.scrollToLatest === false;
      if (background) anchor = this.scrollAnchor();
      else this.historyLimit = HISTORY_PAGE_SIZE;
      this.renderedKey = activeKey;
      this.renderedTranscript = t;
      this.scrollOnNextRender = !background;
    }
    if (!activeKey) { setHTML(this, EMPTY_STATE); return; }
    const stepsId = store.state.stepsTurn?.sessionId === activeKey ? store.state.stepsTurn.turnId : null;
    const openTurn = stepsId ? turnsOf(t.records).find(turn => turnKey(turn) === stepsId) : null;
    if (openTurn) {
      const entering = !this.inSteps;
      if (entering) { this.chatScrollTop = this.scroller?.scrollTop ?? 0; this.chatKey = activeKey; this.inSteps = true; }
      setHTML(this, this.renderSteps(openTurn));
      if (entering && this.scroller) this.scroller.scrollTop = 0;
      return;
    }
    if (this.inSteps) {
      // Return to the chat's old position only when it is the same conversation.
      this.inSteps = false;
      this.pendingScroll = this.chatKey === activeKey ? this.chatScrollTop : undefined;
    }
    const visibleRecords = this.visibleRecords(t.records);
    const busy = t.streaming ? this.renderBusy(activeKey) : "";
    const activity = this.renderActivity(t.records);
    const notice = this.renderCommandNotice();
    const restore = this.scrollOnNextRender && visibleRecords.length ? savedScroll(activeKey) : anchor;
    if (restore?.rec) {
      const index = visibleRecords.findIndex(record => record.id === restore.rec);
      if (index >= 0) this.historyLimit = Math.max(this.historyLimit || HISTORY_PAGE_SIZE, visibleRecords.length - index + 1);
    }
    const history = this.historyRecords(visibleRecords);
    // Before the first prompt, extension activity (observational memory, advisor, …) and notices
    // sit under the greeting instead of replacing it.
    if (!busy && visibleRecords.every(record => record.role === "activity")) {
      setHTML(this, EMPTY_STATE + visibleRecords.map(m => this.renderRecordCached(m)).join("") + activity + notice);
      return;
    }
    const turns = turnsOf(visibleRecords);
    const doneRows = this.doneRows(turns, t.streaming);
    const replies = replyLayout(turns, t.streaming);
    const records = history.records.map(m => {
      const html = this.renderRecordCached(m, replies.get(m.id));
      const row = m.id ? doneRows.get(m.id) || "" : "";
      return (m.id && html.startsWith("<div ") ? `<div data-rec="${esc(m.id)}" ${html.slice(5)}` : html) + row;
    }).join("");
    setHTML(this, records + busy + this.renderQueue(activeKey) + activity + notice);
    if (this.pendingScroll != null) {
      // Back from the steps view: return to where the chat was, not the bottom.
      const top = this.pendingScroll;
      this.pendingScroll = null;
      if (this.scroller) this.scroller.scrollTop = top;
      return;
    }
    if (anchor) {
      if (!(anchor.rec && this.restoreScroll(anchor))) this.autoscroll(!!anchor.bottom);
      delete t.scrollToLatest;
      return;
    }
    if (restore?.rec && this.restoreScroll(restore)) {
      delete t.scrollToLatest;
      this.scrollOnNextRender = false;
      return;
    }
    const forceScroll = this.scrollOnNextRender || !!t.scrollToLatest;
    this.autoscroll(forceScroll);
    delete t.scrollToLatest;
    this.scrollOnNextRender = false;
  }

  /** Messages waiting for the running turn, dimmed, with one control that drops them all. */
  renderQueue(sessionId) {
    const queue = store.state.queued[sessionId];
    if (!queue) return "";
    const bubble = text => `<div class="msg queued-msg"><div class="msg-user-row"><div class="user-message-content"><div class="bubble"><div>${esc(text)}</div></div></div></div></div>`;
    const count = queue.steering.length + queue.followUp.length;
    return [...queue.steering, ...queue.followUp].map(bubble).join("")
      + `<div class="msg queued-actions"><button type="button" class="turn-done-row" data-act="clear-queue">${count} queued · Clear queue<span aria-hidden="true">›</span></button></div>`;
  }

  /** The live line while a turn runs: pi-summarize's working message, else pi's default "Working…". */
  renderBusy(sessionId) {
    const text = store.state.workingMessages?.[sessionId] || "Working…";
    startSpinners();
    return `<div class="msg busy-row" role="status" aria-live="polite"><span class="busy-dots" data-busy-dots aria-hidden="true">${dotGrid(spinnerFrame)}</span><span class="busy-text">${esc(text)}</span></div>`;
  }

  /** One quiet row per finished turn that did work; it opens that turn's steps. */
  doneRows(turns, streaming) {
    const rows = new Map();
    turns.forEach((turn, index) => {
      const last = turn.records.at(-1);
      if (!last || (streaming && index === turns.length - 1)) return;
      const { steps, duration } = turnStats(turn);
      if (!steps && !turn.records.some(record => record.thinking || record.role === "summary")) return;
      const label = [duration ? `Worked ${workedFor(duration)}` : "Worked", steps ? `${steps} step${steps === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
      rows.set(last.id, `<div class="msg turn-done"><button class="turn-done-row" type="button" data-steps-open="${esc(turnKey(turn))}" aria-label="${esc(`${label}. Show steps`)}">${esc(label)}<span aria-hidden="true">›</span></button></div>`);
    });
    return rows;
  }

  openSteps(turnId) {
    history.pushState({ piSteps: true }, "", stepsHash(turnId));
    store.set({ stepsTurn: { sessionId: store.activeKey(), turnId } });
  }

  closeSteps() {
    if (history.state?.piSteps) history.back();
    else {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      store.set({ stepsTurn: null });
    }
  }

  /** Browser back and forward move between the chat and the steps view. */
  syncSteps() {
    const match = /^#steps=(.+)$/.exec(location.hash);
    const current = store.state.stepsTurn;
    if (!match) { if (current) store.set({ stepsTurn: null }); return; }
    const turnId = decodeURIComponent(match[1]);
    if (current?.turnId !== turnId) store.set({ stepsTurn: { sessionId: store.activeKey(), turnId } });
  }

  renderSteps(turn) {
    const { steps, duration } = turnStats(turn);
    // A pi-summarize "continues" entry is a step merged into the breadcrumb before it: its tools join that group.
    const summaries = [];
    for (const record of turn.records) {
      if (record.role !== "summary") continue;
      const previous = summaries.at(-1);
      if (record.continues && previous) previous.toolCallIds = [...previous.toolCallIds, ...(record.toolCallIds || [])];
      else summaries.push({ ...record, toolCallIds: [...(record.toolCallIds || [])] });
    }
    const claimed = new Set();
    const groups = summaries.map(summary => {
      const ids = new Set(summary.toolCallIds);
      const members = turn.records.filter(record => (record.role === "tool" && ids.has(record.id))
        || (record.role === "assistant" && record.thinking && (record.toolIds || []).some(id => ids.has(id))));
      members.forEach(record => claimed.add(record));
      const key = `summary:${summary.id}`;
      const open = this.isOpen(key);
      const count = members.filter(record => record.role === "tool").length;
      return `<section class="step-group">
        <button class="step-summary" type="button" aria-expanded="${open}" data-toggle="${esc(key)}">
          <span class="bh-caret">${open ? "▾" : "▸"}</span><span class="step-summary-text">${esc(summary.text)}</span><span class="bh-meta">${count} step${count === 1 ? "" : "s"}</span>
        </button>${open ? `<div class="step-group-body">${this.stepRows(members, turn.records)}</div>` : ""}
      </section>`;
    }).join("");
    const loose = turn.records.filter(record => !claimed.has(record)
      && (record.role === "tool" || (record.role === "assistant" && record.thinking)));
    const looseRows = loose.length
      ? `${summaries.length ? `<h2 class="steps-subhead">Other steps</h2>` : ""}<div class="step-list">${this.stepRows(loose, turn.records)}</div>`
      : "";
    const empty = !groups && !looseRows ? `<p class="steps-empty">No steps were recorded for this turn.</p>` : "";
    const meta = [duration ? `Worked ${workedFor(duration)}` : "", steps ? `${steps} step${steps === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    return `<div class="steps-view">
      <header class="steps-head">
        <button class="steps-back" type="button" data-steps-back aria-label="Back to chat">&lt;</button>
        <div class="steps-title"><strong>Steps</strong><span>${esc(clip(turn.user.text, 70))}${meta ? ` · ${esc(meta)}` : ""}</span></div>
      </header>
      <div class="steps-body">${groups}${looseRows}${empty}</div>
    </div>`;
  }

  stepRows(records, lookup) {
    return records.map(record => {
      if (record.role === "assistant") return this.thinkingBlock(record);
      const diff = lookup.find(item => item.role === "diff" && item.id === `${record.id}:d`);
      return this.toolBlock(record) + (diff ? this.diffBlock(diff) : "");
    }).join("");
  }

  thinkingBlock(m) {
    const key = `think:${m.id}`;
    const open = this.isOpen(key);
    return `<div class="block step-block">
        <div class="block-head" role="button" tabindex="0" aria-expanded="${open}" data-toggle="${esc(key)}">
          <span class="bh-caret">${open ? "▾" : "▸"}</span><span class="bh-name">Thinking</span><span class="bh-arg">${esc(clip(m.thinking, 90))}</span>
        </div>
        ${open ? `<div class="step-thinking">${esc(m.thinking)}</div>` : ""}
      </div>`;
  }

  toolBlock(m) {
    const open = this.isOpen(m.id);
    return `<div class="block step-block">
        <div class="block-head" role="button" tabindex="0" aria-expanded="${open}" data-toggle="${esc(m.id)}">
          <span class="bh-caret">${open ? "▾" : "▸"}</span>
          <span class="bh-name">${esc(m.tool)}</span>
          <span class="bh-arg">${esc(m.arg)}</span>
          <span class="bh-meta">${esc(m.meta)}</span>
        </div>
        ${open ? `<pre>${esc(m.out)}</pre>` : ""}
      </div>`;
  }

  diffBlock(m) {
    const open = this.isOpen(m.id);
    const lines = open ? (m.lines || []).map(l => {
      const cls = l.sign === "+" ? "add" : l.sign === "-" ? "del" : l.sign === "" ? "hunk" : "";
      return `<div class="diff-line ${cls}"><span class="sign">${esc(l.sign)}</span>${esc(l.text)}</div>`;
    }).join("") : "";
    return `<div class="block step-block">
        <div class="block-head" role="button" tabindex="0" aria-expanded="${open}" data-toggle="${esc(m.id)}">
          <span class="bh-caret">${open ? "▾" : "▸"}</span>
          <span class="bh-name">edit</span>
          <span class="bh-arg rtl">${esc(m.file)}</span>
          <span class="bh-add">${esc(m.add)}</span>
          <span class="bh-del">${esc(m.del)}</span>
        </div>
        ${open ? `<div class="diff-body">${lines}</div>` : ""}
      </div>`;
  }

  renderActivity(records) {
    const latest = new Map();
    for (const record of records) {
      if (record.role === "activity" && record.key) {
        const identity = record.kind === "agent" ? agentRunId(record) : record.key;
        const existing = latest.get(identity);
        if (!existing || (Number(record.revision) || 0) >= (Number(existing.revision) || 0)) latest.set(identity, record);
      }
    }
    const todo = latest.get("todo");
    const agents = [...latest.values()].filter(record => agentRecord(record) && liveAgent(record));
    const todoItems = (todo?.items || []).filter(item => item.status !== "deleted");
    const todoDone = todoItems.filter(item => item.status === "completed").length;
    const todoRows = todoItems.map(item => {
      const status = item.status === "completed" ? "done" : item.status === "in_progress" ? "active" : "pending";
      const label = item.status === "in_progress" ? item.activeForm || item.subject : item.subject;
      return `<div class="activity-task ${status}"><span class="activity-glyph">${status === "done" ? "✓" : status === "active" ? "◐" : "○"}</span><span>${esc(label)}</span></div>`;
    }).join("");
    const panel = (key, title, meta, body, defaultOpen, extraClass = "") => {
      const open = store.state.openActivity[key] ?? defaultOpen;
      return `<section class="activity-panel ${extraClass || (key === "todo" ? "todo-panel" : "agent-panel")}" aria-label="${esc(title)}">
        <button class="activity-head" type="button" data-activity-toggle="${esc(key)}" aria-expanded="${open}">
          <strong>${esc(title)}</strong><span>${esc(meta)} <b class="activity-caret">${open ? "▾" : "▸"}</b></span>
        </button>${open ? `<div class="activity-body">${body}</div>` : ""}
      </section>`;
    };
    const todoPanel = todoItems.length
      ? panel("todo", "Todos", `${todoDone}/${todoItems.length}`, todoRows, false)
      : "";

    const groups = new Map();
    for (const agent of agents) {
      const key = agentGroupId(agent);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(agent);
    }
    const agentPanels = [...groups.entries()].map(([groupId, group]) => {
      const key = `subagents:${groupId}`;
      const counts = group.reduce((result, agent) => {
        result[agent.status] = (result[agent.status] || 0) + 1;
        return result;
      }, {});
      const meta = [
        counts.running ? `${counts.running} running` : "",
        counts.queued ? `${counts.queued} queued` : "",
      ].filter(Boolean).join(" · ");
      const rows = [...group]
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
        .map(agent => {
          const status = agent.status;
          const duration = elapsedAgent(agent);
          const details = [status, agent.activity || "", agent.toolCount ? `${agent.toolCount} tool${agent.toolCount === 1 ? "" : "s"}` : "", duration].filter(Boolean).join(" · ");
          const summary = agent.summary ? `<div class="subagent-summary markdown-content">${renderMarkdown(agent.summary)}</div>` : "";
          return `<div class="subagent-row ${esc(status)}" data-subagent-id="${esc(agentRunId(agent))}">
            <span class="subagent-glyph" aria-hidden="true">${agentStatusGlyph(agent.status)}</span>
            <div class="subagent-main"><div class="subagent-title"><strong>${esc(agent.title || "Background agent")}</strong><span>${esc(details)}</span></div>${summary}</div>
          </div>`;
        }).join("");
      return panel(key, "Parallel work", meta || "working", `<div class="subagent-list">${rows}</div>`, true, "subagent-panel agent-panel");
    }).join("");
    if (!todoPanel && !agentPanels) return "";
    return `<div class="activity-stack">${todoPanel}${agentPanels}</div>`;
  }

  renderCommandNotice() {
    const notice = store.state.commandNotice;
    if (!notice || notice.sessionId !== store.activeKey()) return "";
    const stats = notice.stats;
    const message = stats
      ? `Messages ${stats.messages} · user ${stats.user} · assistant ${stats.assistant} · tools ${stats.tools} · tokens ${stats.tokens?.total || 0} · cost ${Number(stats.cost || 0).toFixed(4)}`
      : notice.message || "";
    return `<section class="command-notice" role="status"><strong>${esc(notice.title || "Pi")}</strong><span>${esc(message)}</span></section>`;
  }

  /** Copies the message's source text (markdown for replies), then shows a check for a moment. */
  async copyMessage(button) {
    const id = button.closest("[data-rec]")?.dataset.rec;
    const records = store.transcript().records;
    const record = records.find(r => r.id === id);
    const turn = button.hasAttribute("data-copy-turn") && turnsOf(records).find(item => item.records.includes(record));
    const text = turn
      ? turn.records.filter(r => r.role === "assistant" && r.text).map(r => r.text).join("\n\n")
      : record?.text ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      store.setError("Clipboard access is unavailable in this browser.");
      return;
    }
    const glyph = button.hasAttribute("data-copy-turn") ? "copyTurn" : "copy";
    const aria = button.getAttribute("aria-label");
    button.classList.add("copied");
    setHTML(button, icon("check"));
    button.setAttribute("aria-label", "Copied");
    setTimeout(() => {
      button.classList.remove("copied");
      setHTML(button, icon(glyph));
      button.setAttribute("aria-label", aria);
    }, 1500);
  }

  renderRecordCached(m, reply = null) {
    const open = m.role === "tool" || m.role === "diff"
      ? this.isOpen(m.id)
      : m.role === "activity" ? (store.state.openActivity[m.key] ?? false) : false;
    const cached = this.renderCache.get(m);
    const signature = [m.role, m.id, m.key, m.status, m.title, m.summary, m.text, m.streaming, m.pending, m.deliveryError, m.meta, m.file, m.add, m.del, m.cmd, open, open ? m.out : null, reply?.final, reply?.replies];
    if (cached?.signature.length === signature.length
      && cached.signature.every((value, index) => value === signature[index])) return cached.html;
    const html = this.renderRecord(m, reply);
    this.renderCache.set(m, { signature, html });
    return html;
  }

  renderRecord(m, reply = null) {
    if (m.role === "activity" && m.key === "compaction") {
      const status = m.status || "completed";
      return `<div class="msg activity-inline"><div class="activity-status ${esc(status)}" role="status" aria-live="polite">
        <span class="activity-status-glyph">${status === "running" ? "◐" : status === "completed" ? "✓" : "!"}</span>
        <strong>${esc(m.title || "Context compaction")}</strong><span>${esc(m.summary || "")}</span>
      </div></div>`;
    }
    if (m.role === "activity" && m.kind === "agent") {
      const open = store.state.openActivity[m.key] ?? false;
      return `<div class="msg activity-inline"><div class="block">
        <div class="block-head" role="button" tabindex="0" aria-expanded="${open}" data-activity-toggle="${esc(m.key)}">
          <span class="bh-caret">${open ? "▾" : "▸"}</span><span class="bh-name">${esc(m.title || "Activity")}</span>
          <span class="bh-arg">background activity</span><span class="bh-meta">${esc(m.status || "completed")}</span>
        </div>${open ? `<div class="activity-inline-body markdown-content">${renderMarkdown(m.summary || "")}</div>` : ""}
      </div></div>`;
    }
    if (m.role === "user") {
      const delivery = m.deliveryError ? "ERROR: Unable to send." : "";
      return `<div class="msg ${m.deliveryError ? "delivery-failed" : ""}">
        <div class="msg-user-row">
          <div class="user-message-content"><div class="bubble" data-copy-reveal>${(m.images || []).map(image => `<img class="message-image" src="data:${esc(image.mimeType)};base64,${esc(image.data)}" alt="Attached image">`).join("")}${m.text ? `<div>${esc(m.text)}</div>` : ""}</div>${delivery ? `<div class="delivery-status">${esc(delivery)}</div>` : ""}${m.text ? copyButton("user") : ""}</div>
        </div></div>`;
    }
    if (m.role === "error") {
      return `<div class="msg"><div class="turn-error" role="alert">ERROR: ${esc(m.text || "Service unavailable.")}</div></div>`;
    }
    if (m.role === "assistant") {
      // Thinking-only and tool-only messages have no chat text; the busy line and steps cover them.
      if (!m.text) return "";
      const final = !m.streaming && (reply?.final ?? true);
      return `<div class="msg${final ? "" : " reply-mid"}"><div class="assist" ${m.streaming ? "data-live-text" : ""}><div class="markdown-content">${renderMarkdown(m.text)}</div>${m.streaming ? `<span class="caret-bar"></span>` : ""}</div>${final ? copyButton("assistant", reply?.replies) : ""}</div>`;
    }
    // Tool calls, diffs, and summaries belong to the turn's steps view, not the chat.
    if (m.role === "tool" || m.role === "diff" || m.role === "summary") return "";
    if (m.role === "bang") {
      return `<div class="msg"><div class="block bang">
        <div class="block-head">
          <span class="sigil">!</span>
          <span class="bh-cmd">${esc(m.cmd)}</span>
          <span class="bh-meta">${esc(m.meta)}</span>
        </div>
        ${m.out ? `<pre>${esc(m.out)}</pre>` : ""}
      </div></div>`;
    }
    return "";
  }
}

/* ---------------- model picker ---------------- */
class PiModelPicker extends HTMLElement {
  connectedCallback() {
    this.open = false;
    this.focusedIndex = 0;
    this.mode = this.dataset.mode === "default" ? "default" : "session";
    this.onDocumentPointer = e => {
      if (this.open && !this.contains(e.target)) this.close();
    };
    this.onViewport = () => { if (this.open) this.positionPopover(); };
    document.addEventListener("pointerdown", this.onDocumentPointer);
    window.addEventListener("resize", this.onViewport);
    window.addEventListener("scroll", this.onViewport, true);
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => this.onKeyDown(e));
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener("pointerdown", this.onDocumentPointer);
    window.removeEventListener("resize", this.onViewport);
    window.removeEventListener("scroll", this.onViewport, true);
  }
  current() {
    return this.mode === "default"
      ? store.state.defaultModel
      : store.state.model || store.state.effectiveDefaultModel || null;
  }
  close(returnFocus = false) {
    if (!this.open) return;
    this.open = false;
    this.render();
    if (returnFocus) this.querySelector("[data-model-toggle]")?.focus();
  }
  options() { return [...this.querySelectorAll("[data-model]:not([disabled]), [data-model-automatic]:not([disabled])")]; }
  optionValue(option) { return option?.hasAttribute("data-model-automatic") ? null : option?.dataset.model; }
  onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close(true);
      return;
    }
    const toggle = e.target.closest("[data-model-toggle]");
    if (!this.open) {
      if (toggle && ["ArrowDown", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        this.open = true;
        this.focusedIndex = 0;
        this.render();
        this.focusOption();
      }
      return;
    }
    const options = this.options();
    if (!options.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.focusedIndex = (this.focusedIndex + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      this.focusOption();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.focusedIndex = e.key === "Home" ? 0 : options.length - 1;
      this.focusOption();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void this.choose(this.optionValue(options[this.focusedIndex]));
    }
  }
  focusOption() {
    const options = this.options();
    const option = options[this.focusedIndex];
    option?.focus();
    option?.scrollIntoView?.({ block: "nearest" });
  }
  onClick(e) {
    const toggle = e.target.closest("[data-model-toggle]");
    if (toggle) {
      this.open = !this.open;
      this.focusedIndex = 0;
      this.render();
      if (this.open) this.focusOption();
      return;
    }
    const automatic = e.target.closest("[data-model-automatic]");
    if (automatic) {
      void this.choose(null);
      return;
    }
    const option = e.target.closest("[data-model]");
    if (option && !option.disabled) void this.choose(option.dataset.model);
  }
  async choose(id) {
    const previous = this.current();
    const previousModelState = {
      model: previous,
      requestedModel: store.state.requestedModel,
      modelFallback: store.state.modelFallback,
      modelUnavailable: store.state.modelUnavailable,
    };
    this.open = false;
    if (this.mode === "default") store.set({ defaultModel: id });
    else store.set({ model: id, requestedModel: null, modelFallback: false, modelUnavailable: false });
    try {
      if (this.mode === "default") {
        const result = await api.settings(id);
        store.set({
          defaultModel: result.defaultModel ?? null,
          effectiveDefaultModel: result.effectiveDefaultModel ?? null,
          defaultModelStatus: result.defaultModelStatus || "automatic",
          modelError: result.modelError || null,
        });
      } else if (store.activeKey()) {
        await api.setModel(store.activeKey(), id);
      }
    } catch (err) {
      if (this.mode === "default") store.set({ defaultModel: previous });
      else store.set(previousModelState);
      store.setError(err.error === "model_unavailable"
        ? "That model is unavailable."
        : `Model change failed: ${err.message || err}`);
    }
  }
  positionPopover() {
    const popover = this.querySelector(".model-popover");
    const anchor = this.querySelector("[data-model-toggle]");
    if (!popover || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const headerAllowance = 42;
    const compactListCap = 220;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const width = Math.min(276, Math.max(0, viewportWidth - margin * 2));
    const aboveRoom = Math.max(0, a.top - margin);
    const belowRoom = Math.max(0, viewportHeight - a.bottom - margin);
    const above = aboveRoom >= belowRoom;
    const sideRoom = above ? aboveRoom : belowRoom;
    const listHeight = Math.min(compactListCap, Math.max(96, sideRoom - gap - headerAllowance));
    const maxPopoverHeight = Math.max(140, Math.min(viewportHeight - margin * 2, listHeight + headerAllowance));
    const height = Math.min(popover.getBoundingClientRect().height || maxPopoverHeight, maxPopoverHeight);
    const left = Math.max(margin, Math.min(a.right - width, viewportWidth - width - margin));
    const top = above
      ? Math.max(margin, a.top - height - gap)
      : Math.min(viewportHeight - margin - height, a.bottom + gap);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.width = `${width}px`;
    popover.style.maxHeight = `${maxPopoverHeight}px`;
    popover.querySelector(".model-list")?.style.setProperty("max-height", `${listHeight}px`);
  }
  render() {
    const current = this.current();
    const model = store.state.models.find(m => m.id === current);
    const configuredUnavailable = this.mode === "default" && current && !model && store.state.defaultModelStatus === "unavailable";
    const chipLabel = this.mode === "default"
      ? (model?.label || (configuredUnavailable ? `${current} (unavailable)` : "Automatic"))
      : (model?.label || current || "Automatic");
    const variant = this.dataset.variant === "settings" ? "settings-chip" : "model-chip";
    const groups = new Map();
    for (const m of store.state.models) {
      const key = m.provider || m.id.split("/")[0] || "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const options = [...groups.entries()].map(([provider, models]) => `
      <div class="model-group" role="group" aria-label="${esc(provider)}">
        <div class="model-group-label">${esc(provider)}</div>
        ${models.map(m => `
          <button class="model-option ${m.id === current ? "current" : ""}" role="option"
            aria-selected="${m.id === current}" data-model="${esc(m.id)}">
            <span class="model-option-main">${esc(m.label || m.id)}</span>
            <span class="model-option-meta">${esc(m.provider || "")}</span>
            ${m.id === current ? `<span class="model-option-check">✓</span>` : ""}
          </button>`).join("")}
      </div>`).join("");
    const automatic = this.mode === "default" ? `
      <button class="model-option ${current === null ? "current" : ""}" role="option"
        aria-selected="${current === null}" data-model-automatic>
        <span class="model-option-main">Automatic</span>
        <span class="model-option-meta">first available model</span>
        ${current === null ? `<span class="model-option-check">✓</span>` : ""}
      </button>` : "";
    const sessionFallback = this.mode === "session" && store.state.modelFallback && store.state.requestedModel
      ? `<div class="model-unavailable">${esc(store.state.requestedModel)} is unavailable.<br><span>Using ${esc(model?.label || current || "no model")}</span></div>`
      : this.mode === "session" && store.state.modelUnavailable && store.state.requestedModel
        ? `<div class="model-unavailable">Model unavailable:<br><span>${esc(store.state.requestedModel)}</span></div>`
        : "";
    const unavailable = configuredUnavailable ? `
      <div class="model-unavailable">Configured model unavailable:<br><span>${esc(current)}</span></div>` : sessionFallback;
    const empty = !options && !unavailable
      ? `<div class="model-empty">No models available.<br><span>Connect a provider in Settings.</span></div>` : "";
    const popoverId = this._popoverId ||= `model-popover-${Math.random().toString(36).slice(2, 9)}`;
    setHTML(this, `<div class="model-picker">
      <button class="${variant}" data-model-toggle aria-haspopup="listbox" aria-controls="${popoverId}" aria-expanded="${this.open}"
        title="Choose model">${esc(chipLabel)}</button>
      ${this.open ? `<div id="${popoverId}" class="model-popover" role="dialog" aria-label="Choose model">
        <div class="model-popover-head">Choose model</div>
        <div class="model-list" role="listbox">${automatic}${unavailable}${options || empty}</div>
      </div>` : ""}
    </div>`);
    if (this.open) this.positionPopover();
  }
}

/* ---------------- context window ---------------- */
const tokenLabel = value => {
  const tokens = Number(value);
  if (!Number.isFinite(tokens)) return "—";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens));
};
class PiContextMeter extends HTMLElement {
  connectedCallback() {
    this.open = false;
    this.info = null;
    this.unsub = store.subscribe(w => {
      if (w === "state" || w === "transcript") this.sync();
    });
    this.addEventListener("click", e => {
      if (e.target.closest("[data-context-toggle]")) {
        this.open = !this.open;
        this.render();
      }
    });
    this.sync();
  }
  disconnectedCallback() { this.unsub?.(); }
  async sync() {
    const id = store.activeKey();
    const transcript = store.transcript(id);
    const lastAssistant = [...transcript.records].reverse().find(record => record.role === "assistant");
    const key = `${id || ""}:${store.state.model || ""}:${transcript.streaming}:${lastAssistant?.id || ""}:${lastAssistant?.text?.length || 0}`;
    if (!id || key === this.contextKey) return;
    this.contextKey = key;
    try {
      const info = await api.context(id);
      if (id !== store.activeKey()) return;
      this.info = info;
      this.render();
    } catch {
      if (id === store.activeKey()) { this.info = null; this.render(); }
    }
  }
  render() {
    const info = this.info;
    if (!store.activeKey()) { this.innerHTML = ""; return; }
    const percent = Number.isFinite(info?.percent) ? info.percent : null;
    const tone = percent == null ? "unknown" : percent >= 85 ? "danger" : percent >= 70 ? "warn" : "ok";
    const label = percent == null ? "Context unavailable" : `Context ${tokenLabel(info.used)} / ${tokenLabel(info.window)} · ${percent}%`;
    const details = info && percent != null ? `<div class="context-popover" role="status">
      <strong>Context window</strong>
      <span>${tokenLabel(info.used)} used · ${tokenLabel(info.remaining)} remaining</span>
      <span>Input ${tokenLabel(info.input)} · cache ${tokenLabel((info.cacheRead || 0) + (info.cacheWrite || 0))}</span>
      ${info.model ? `<span>${esc(info.model)}</span>` : ""}
    </div>` : "";
    this.innerHTML = `<div class="context-meter ${tone}">
      <button data-context-toggle aria-expanded="${this.open}" title="Context window usage">
        <span>${label}</span>${percent != null ? `<i><b style="width:${percent}%"></b></i>` : ""}
      </button>
      ${this.open ? details : ""}
    </div>`;
  }
}

/* ---------------- thinking effort ---------------- */
const THINKING_HINTS = { off: "no reasoning", minimal: "fastest", low: "quick", medium: "balanced", high: "thorough", xhigh: "deeper", max: "most thorough" };
class PiThinkingPicker extends HTMLElement {
  connectedCallback() {
    this.open = false;
    this.info = null;
    this.addEventListener("click", e => {
      const toggle = e.target.closest("[data-thinking-toggle]");
      if (toggle) { this.open = !this.open; this.render(); return; }
      const option = e.target.closest("[data-thinking-level]");
      if (option) void this.choose(option.dataset.thinkingLevel);
    });
    this.addEventListener("keydown", e => {
      if (e.key === "Escape" && this.open) { e.preventDefault(); this.open = false; this.render(); this.querySelector("[data-thinking-toggle]")?.focus(); }
    });
    this.onDocumentPointer = e => { if (this.open && !this.contains(e.target)) { this.open = false; this.render(); } };
    document.addEventListener("pointerdown", this.onDocumentPointer);
    this.unsub = store.subscribe(w => { if (w === "state") this.sync(); });
    this.sync();
  }
  disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener("pointerdown", this.onDocumentPointer);
  }
  async sync() {
    const id = store.activeKey();
    if (!id || id === this.sessionId) return;
    this.sessionId = id;
    this.open = false;
    // Keep the effort control present even when a provider does not advertise
    // reasoning metadata. Pi will clamp unsupported choices server-side.
    this.info = { level: "medium", levels: THINKING_LEVELS, supported: true };
    this.render();
    try {
      const info = await api.thinking(id);
      if (id !== store.activeKey() || !Array.isArray(info.levels)) return;
      this.info = info.levels.length > 1
        ? info
        : { ...this.info, level: info.level || this.info.level };
      this.render();
    } catch { /* retain the available fallback while a server is restarting */ }
  }
  async choose(level) {
    const id = store.activeKey();
    if (!id) return;
    try {
      this.info = await api.setThinking(id, level);
      this.open = false;
      this.render();
    } catch (err) { store.setError(`Thinking effort change failed: ${err.message || err}`); }
  }
  render() {
    const info = this.info;
    if (!info?.levels?.length) { this.innerHTML = ""; return; }
    const level = info.level || "off";
    this.innerHTML = `<div class="thinking-picker">
      <button class="thinking-chip" data-thinking-toggle aria-haspopup="listbox" aria-expanded="${this.open}" title="Thinking effort">${esc(level)}</button>
      ${this.open ? `<div class="model-popover thinking-popover" role="dialog" aria-label="Thinking effort">
        <div class="model-popover-head">Thinking effort</div>
        <div class="model-list" role="listbox"><div class="model-group">
        ${info.levels.map(item => `<button class="model-option ${item === level ? "current" : ""}" role="option" aria-selected="${item === level}" data-thinking-level="${esc(item)}">
          <span class="model-option-main">${esc(item)}</span>
          <span class="model-option-meta">${esc(THINKING_HINTS[item] || "")}</span>
          ${item === level ? `<span class="model-option-check">✓</span>` : ""}
        </button>`).join("")}
        </div></div>
      </div>` : ""}
    </div>`;
  }
}

/* ---------------- composer ---------------- */
class PiComposer extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<div class="composer-outer"><div class="composer-pad"><div class="composer">
      <div class="command-popover hidden" role="listbox" aria-label="Pi commands"></div>
      <div class="composer-attachments"></div>
      <textarea rows="2"></textarea>
      <div class="composer-foot">
        <div class="attachment-picker">
          <span class="attach-btn" aria-hidden="true">＋</span>
          <input class="image-input" type="file" accept="image/*" multiple title="Attach images" aria-label="Attach images">
        </div>
        <pi-context-meter></pi-context-meter>
        <pi-model-picker data-mode="session" data-variant="composer"></pi-model-picker>
        <pi-thinking-picker></pi-thinking-picker>
        <button class="stop-btn hidden" type="button" aria-label="Stop" title="Stop"><span class="sq" aria-hidden="true"></span>Stop</button>
        <button class="send-btn" type="button" title="Send" aria-label="Send message">↑</button>
      </div>
    </div></div></div>`;
    this.ta = this.querySelector("textarea");
    this.attachments = [];
    this.sendingIds = new Set();
    this.attachmentsEl = this.querySelector(".composer-attachments");
    this.imageInput = this.querySelector(".image-input");
    this.stopBtn = this.querySelector(".stop-btn");
    // An off-screen copy measures the draft, so the visible editor never collapses mid-typing (which flickered and lost its scroll).
    this.measure = this.ta.cloneNode();
    this.measure.className = "composer-measure";
    this.measure.setAttribute("aria-hidden", "true");
    this.measure.tabIndex = -1;
    this.ta.after(this.measure);
    this.sendBtn = this.querySelector(".send-btn");

    this.ta.addEventListener("input", () => {
      const id = store.activeKey();
      store.setDraft(this.ta.value, id);
      this.resizeEditor();
      void this.syncCommands();
    });
    // Coming back to a long draft shows its end, where typing continues.
    this.ta.addEventListener("focus", () => {
      if (this.ta.selectionEnd === this.ta.value.length) this.ta.scrollTop = this.ta.scrollHeight;
    });
    this.onViewportResize = () => this.resizeEditor();
    const view = this.ownerDocument?.defaultView;
    view?.addEventListener("resize", this.onViewportResize);
    view?.visualViewport?.addEventListener("resize", this.onViewportResize);
    this.imageInput.addEventListener("change", () => {
      void this.addFiles(this.imageInput.files);
      this.imageInput.value = "";
    });
    this.ta.addEventListener("paste", e => {
      // Safari and some Chromium builds expose pasted screenshots only through items.
      const files = [...(e.clipboardData?.items || [])].filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); void this.addFiles(files); }
    });
    this.addEventListener("click", e => {
      const removeImage = e.target.closest("[data-remove-image]");
      if (removeImage) {
        const id = store.activeKey();
        const attachments = store.draftAttachments(id).slice();
        attachments.splice(Number(removeImage.dataset.removeImage), 1);
        store.setDraftAttachments(attachments, id);
        this.attachments = attachments;
        this.renderAttachments();
        return;
      }
      const option = e.target.closest("[data-command-index]");
      if (!option) return;
      this.commandIndex = Number(option.dataset.commandIndex);
      this.chooseCommand();
    });
    this.ta.addEventListener("keydown", e => {
      if (this.commandOpen && this.commandQuery() !== null && ["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(e.key)) {
        if (e.key === "Escape") { e.preventDefault(); this.closeCommands(); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.moveCommand(e.key === "ArrowDown" ? 1 : -1); return; }
        if (e.key === "Tab") { e.preventDefault(); this.chooseCommand(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !mobile()) {
        e.preventDefault();
        void this.send(e.altKey ? "followUp" : undefined);
      }
    });
    this.sendBtn.addEventListener("pointerdown", e => {
      if (!store.transcript().streaming) return;
      this.sendHoldTimer = setTimeout(() => {
        this.sendHoldTimer = null;
        this.sendHeld = true;
        void this.send("followUp");
      }, 500);
      this.sendBtn.setPointerCapture?.(e.pointerId);
    });
    const cancelSendHold = () => {
      if (this.sendHoldTimer) clearTimeout(this.sendHoldTimer);
      this.sendHoldTimer = null;
    };
    this.sendBtn.addEventListener("pointerup", cancelSendHold);
    this.sendBtn.addEventListener("pointercancel", cancelSendHold);
    this.sendBtn.addEventListener("click", e => {
      e.preventDefault();
      if (this.sendHeld) { this.sendHeld = false; return; }
      void this.send();
    });
    this.stopBtn.addEventListener("click", () => api.stop(store.activeKey()).catch(err => store.setError(`Stop failed: ${err.message || err}`)));
    this.unsub = store.subscribe(w => { if (w === "state" || w === "transcript") this.sync(); });
    this.commands = [];
    this.allCommands = [];
    this.commandRequest = 0;
    this.commandOpen = false;
    this.commandIndex = 0;
    this.commandSessionId = null;
    this.sync();
  }
  disconnectedCallback() {
    this.unsub?.();
    const view = this.ownerDocument?.defaultView;
    view?.removeEventListener("resize", this.onViewportResize);
    view?.visualViewport?.removeEventListener("resize", this.onViewportResize);
    if (this.sendHoldTimer) clearTimeout(this.sendHoldTimer);
  }

  lineHeight() {
    const styles = this.ownerDocument?.defaultView?.getComputedStyle?.(this.ta);
    const value = Number.parseFloat(styles?.lineHeight || "");
    return Number.isFinite(value) && value > 0 ? value : 22.5;
  }

  collapsedEditorHeight() {
    const styles = this.ownerDocument?.defaultView?.getComputedStyle?.(this.ta);
    const top = Number.parseFloat(styles?.paddingTop || "") || 13;
    const bottom = Number.parseFloat(styles?.paddingBottom || "") || 5;
    return Math.ceil(this.lineHeight() * 2 + top + bottom);
  }

  viewportHeight() {
    const view = this.ownerDocument?.defaultView;
    return Math.max(0, view?.visualViewport?.height || view?.innerHeight || this.ownerDocument?.documentElement?.clientHeight || 768);
  }

  maxEditorHeight(collapsed) {
    const app = this.closest("main.col") || this.closest("pi-app");
    const headerHeight = app?.querySelector("pi-header .bar")?.getBoundingClientRect?.().height || 0;
    const composer = this.querySelector(".composer");
    const composerHeight = composer?.getBoundingClientRect?.().height || 0;
    const editorHeight = this.ta.getBoundingClientRect?.().height || collapsed;
    const fixedHeight = Math.max(52, composerHeight > editorHeight ? composerHeight - editorHeight : 52);
    const minChatHeight = Math.ceil(this.lineHeight() * 2 + 24);
    const available = this.viewportHeight() - headerHeight - minChatHeight - fixedHeight;
    return Math.max(collapsed, available);
  }

  /** Typing grows the editor up to 40% of the visible viewport (above the keyboard on phones), then it scrolls. */
  autoEditorHeight(collapsed, maxHeight) {
    return Math.max(collapsed, Math.min(maxHeight, this.viewportHeight() * 0.4));
  }

  resizeEditor() {
    if (!this.ta) return;
    const collapsed = this.collapsedEditorHeight();
    const scroller = this.closest("pi-app")?.querySelector(".scrollable");
    const pinned = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    const before = this.ta.style.height;
    this.measure.value = this.ta.value;
    const contentHeight = Math.max(this.measure.scrollHeight || 0, collapsed);
    const maxHeight = this.autoEditorHeight(collapsed, this.maxEditorHeight(collapsed));
    const height = `${Math.ceil(Math.min(contentHeight, maxHeight))}px`;
    if (height !== before) this.ta.style.height = height;
    this.ta.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
    // A taller editor shrinks the transcript; keep the latest reply in view if it was.
    if (pinned && height !== before) scroller.scrollTop = scroller.scrollHeight;
  }

  scrollToLatest() {
    const scroller = this.closest("pi-app")?.querySelector(".scrollable");
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  commandQuery() {
    const match = this.ta.value.match(/^\/([^\s]*)$/);
    return match ? match[1].toLowerCase() : null;
  }
  addPendingMessage(id, text, images) {
    const pendingId = `pending:${id}:${Date.now()}:${++pendingMessageSequence}`;
    store.transcript(id).records.push({ id: pendingId, pendingId, role: "user", text, images, pending: true });
    store.notify("transcript");
    return pendingId;
  }
  markPendingMessage(id, pendingId, message) {
    if (!pendingId) return;
    const record = store.transcript(id).records.find(item => item.pendingId === pendingId);
    if (!record) return;
    record.pending = false;
    record.deliveryError = message;
    store.notify("transcript");
  }
  async syncCommands() {
    const query = this.commandQuery();
    const id = store.activeKey();
    if (query === null || !id) { this.closeCommands(); return; }
    const request = ++this.commandRequest;
    try {
      if (id !== this.commandSessionId) {
        const result = await api.commands(id);
        if (request !== this.commandRequest || id !== store.activeKey() || this.commandQuery() === null) return;
        this.allCommands = result.commands || [];
        this.commandSessionId = id;
      }
      if (request !== this.commandRequest || id !== store.activeKey() || this.commandQuery() === null) return;
      this.commands = this.allCommands.filter(command => !query || command.name.toLowerCase().includes(query));
      this.commandIndex = 0;
      this.commandOpen = this.commands.length > 0;
      this.renderCommands();
    } catch {
      if (request === this.commandRequest) this.closeCommands();
    }
  }
  closeCommands() {
    this.commandOpen = false;
    this.renderCommands();
  }
  moveCommand(delta) {
    if (!this.commands.length) return;
    this.commandIndex = (this.commandIndex + delta + this.commands.length) % this.commands.length;
    this.renderCommands();
  }
  chooseCommand() {
    const command = this.commands[this.commandIndex];
    if (!command) return;
    if (!this.ta.value.startsWith("/")) return;
    this.ta.value = `/${command.name} `;
    store.setDraft(this.ta.value);
    this.closeCommands();
    this.ta.focus();
  }
  renderCommands() {
    const popover = this.querySelector(".command-popover");
    if (!popover) return;
    popover.classList.toggle("hidden", !this.commandOpen);
    popover.innerHTML = this.commands.map((command, index) => `<button class="command-option ${index === this.commandIndex ? "current" : ""}" data-command-index="${index}"><span>/${esc(command.name)}</span><small>${esc([command.description || command.source || "", command.argumentHint || ""].filter(Boolean).join(" "))}</small></button>`).join("");
  }

  async handleCommandResult(id, result) {
    if (store.activeKey() !== id) return;
    const action = result?.action;
    if (action === "settings") { store.set({ view: "settings", commandNotice: null }); return; }
    if (action === "model-picker") {
      const picker = this.querySelector("pi-model-picker");
      if (picker) { picker.open = true; picker.focusedIndex = 0; picker.render(); picker.focusOption?.(); }
      return;
    }
    if (action === "download") {
      const link = document.createElement("a");
      link.href = api.exportSession(id, result.format || "html");
      link.download = "";
      document.body.appendChild(link);
      link.click();
      link.remove();
      store.set({ commandNotice: { sessionId: id, title: "Export", message: "Session download started." } });
      return;
    }
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(result.text || "");
        if (store.activeKey() === id) store.set({ commandNotice: { sessionId: id, title: "Copy", message: "Copied the last agent message." } });
      } catch {
        if (store.activeKey() === id) store.setError("Clipboard access is unavailable in this browser.");
      }
      return;
    }
    if (action === "share") {
      store.set({ commandNotice: { sessionId: id, title: "Share", message: result.url || "Private gist created." } });
      return;
    }
    if (action === "notice") {
      store.set({ commandNotice: { sessionId: id, title: result.title, message: result.message, stats: result.stats } });
      return;
    }
    if (action === "refresh") {
      await openTranscript(id);
      if (store.activeKey() === id) store.set({ commandNotice: result.notice === false ? null : { sessionId: id, title: "Pi", message: result.message || "Done." } });
      return;
    }
    if (action === "sidebar") { store.set({ railOpen: true, drawerOpen: true, commandNotice: null }); return; }
    if (action === "new") {
      if (store.state.chatId || !store.state.projectId) await newChat();
      else await newProjectSession(store.state.projectId);
      return;
    }
    if (action === "fork") {
      try {
        const result = await api.forkSession(id);
        if (store.activeKey() !== id) return;
        await refreshState();
        if (store.activeKey() !== id) return;
        if (result.projectId) selectSession(result.projectId, result.id);
        else selectChat(result.id);
      } catch (error) {
        if (store.activeKey() === id) store.setError(error.message || error.error || "Could not fork this session.");
      }
      return;
    }
    if (action === "quit") {
      await closeConversation(id, store.state.chatId ? "chat" : "session");
      return;
    }
    if (action) store.set({ commandNotice: { sessionId: id, title: "Pi", message: result.message || action } });
  }

  async addFiles(files) {
    const id = store.activeKey();
    if (!id) return;
    for (const file of [...(files || [])]) {
      const draft = store.draftData(id);
      if (!file.type.startsWith("image/") || store.draftAttachments(id).length + (draft?.pendingAttachments || 0) >= 4) continue;
      if (file.size > 6_000_000) { store.setError("Images must be smaller than 6 MB."); continue; }
      store.setDraftPendingAttachments((draft?.pendingAttachments || 0) + 1, id);
      if (store.activeKey() === id) this.sync();
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        store.setDraftAttachments([...store.draftAttachments(id), { type: "image", data, mimeType: file.type, name: file.name }], id);
        if (store.activeKey() === id) {
          this.attachments = store.draftAttachments(id).slice();
          this.renderAttachments();
        }
      } catch {
        store.setError("Could not read attached image.");
      } finally {
        store.setDraftPendingAttachments(Math.max(0, (store.draftData(id)?.pendingAttachments || 0) - 1), id);
        if (store.activeKey() === id) this.sync();
      }
    }
  }
  renderAttachments() {
    this.attachmentsEl.innerHTML = this.attachments.map((image, index) => `<div class="attachment-thumb"><img src="data:${esc(image.mimeType)};base64,${esc(image.data)}" alt="${esc(image.name || "Attached image")}"><button type="button" data-remove-image="${index}" aria-label="Remove image">×</button></div>`).join("");
  }
  // The question card (pi-extension-ui) when the open conversation's question takes typed text.
  asking(id = store.activeKey()) {
    const card = document.querySelector("pi-extension-ui");
    return card?.acceptsText?.(id) ? card : null;
  }

  async answer(id, card) {
    const rawText = this.ta.value;
    const sentRevision = store.draftData(id)?.revision;
    this.sendingIds.add(id);
    store.setDraftSending(true, id);
    this.sync();
    try {
      if (await card.answer(rawText) && store.draftData(id)?.revision === sentRevision) {
        store.setDraft("", id);
        if (store.activeKey() === id) this.ta.value = "";
      }
    } finally {
      this.sendingIds.delete(id);
      store.setDraftSending(false, id);
      if (store.activeKey() === id) this.sync();
    }
  }

  async send(forcedMode) {
    const id = store.activeKey();
    const text = this.ta.value.trim();
    const rawText = this.ta.value;
    const card = !forcedMode && !text.startsWith("/") && !text.startsWith("!") ? this.asking(id) : null;
    if (card) {
      if (!this.sendingIds.has(id)) await this.answer(id, card);
      return;
    }
    const draft = store.draftData(id);
    const attachments = store.draftAttachments(id).slice();
    if (!id || (!text && !attachments.length) || store.transcript(id).compacting
      || draft?.pendingAttachments || this.sendingIds.has(id)) return;
    const images = attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
    // While a turn runs the message is queued; the server's queue shows it until Pi delivers it.
    const queuedSend = store.transcript(id).streaming && !text.startsWith("/") && !text.startsWith("!");
    const pendingId = !text.startsWith("/") && !text.startsWith("!") && !queuedSend
      ? this.addPendingMessage(id, text, images)
      : null;
    this.sendingIds.add(id);
    store.setDraftSending(true, id);
    this.scrollToLatest();
    this.ta.value = "";
    this.resizeEditor();
    this.attachments = [];
    this.renderAttachments();
    store.setDraft("", id);
    store.setDraftAttachments([], id);
    const sentRevision = store.draftData(id)?.revision;
    store.set({ commandNotice: null });
    this.sync();
    const streaming = store.transcript(id).streaming;
    const mode = forcedMode || (streaming ? "steer" : "prompt");
    try {
      if (text.startsWith("!")) {
        await api.bang(id, text.slice(1).trim());
      } else if (text.startsWith("/")) {
        const result = await api.command(id, text, mode);
        if (store.activeKey() === id) await this.handleCommandResult(id, result);
      } else {
        await api.message(id, text, mode, images, pendingId);
        // The first prompt is what makes a new session real: show it in the sidebar now.
        const node = store.state.projects.map(p => store.findSession(id, p.sessions)).find(Boolean);
        if (node && isDraft(node)) { node.draft = false; store.notify("state"); }
      }
      if (store.draftData(id)?.revision === sentRevision) store.clearDraft(id);
    } catch (err) {
      const message = err.error === "model_required"
        ? "No model is available."
        : err.message || err.error || String(err);
      this.markPendingMessage(id, pendingId, message);
      const currentDraft = store.draftData(id);
      if (currentDraft?.revision === sentRevision) {
        store.setDraft(rawText, id);
        store.setDraftAttachments(attachments, id);
      }
      store.setError(err.error === "model_required"
        ? "No model is available. Connect a provider or choose one in Settings."
        : `Send failed: ${err.message || err.error || String(err)}`);
    } finally {
      this.sendingIds.delete(id);
      store.setDraftSending(false, id);
      if (store.activeKey() === id) {
        this.ta.value = store.draft(id);
        this.attachments = store.draftAttachments(id).slice();
        this.renderAttachments();
        this.sync();
      }
    }
  }

  sync() {
    const t = store.transcript();
    const p = store.project();
    const compacting = !!t.compacting;
    this.ta.placeholder = store.inProject() && p ? `Ask about ${p.name}…` : "Send a message…";
    const activeId = store.activeKey();
    const draft = store.draft(activeId);
    if (activeId !== this.draftSessionId) {
      this.attachments = store.draftAttachments(activeId).slice();
      this.renderAttachments();
    }
    if (activeId !== this.draftSessionId || (this.ta.value !== draft && document.activeElement !== this.ta)) this.ta.value = draft;
    this.draftSessionId = activeId;
    if (activeId !== this.commandSessionId) {
      this.commandSessionId = null;
      this.commands = [];
      this.allCommands = [];
      this.closeCommands();
    }
    if (this.commandQuery() !== null && activeId) void this.syncCommands();
    else this.renderCommands();
    const error = store.state.error;
    this.ta.classList.toggle("busy", t.streaming || compacting);
    this.ta.classList.toggle("error", !!error);
    this.ta.placeholder = error || (compacting
      ? "Compacting context…"
      : t.streaming ? "Enter a steering message, alt+enter a follow-up…"
        : store.inProject() && p ? `Ask about ${p.name}…` : "Send a message…");
    this.stopBtn.classList.toggle("hidden", !t.streaming);
    const draftState = store.draftData(activeId);
    this.ta.disabled = !!draftState?.sending;
    this.imageInput.disabled = !!draftState?.sending;
    this.sendBtn.disabled = compacting || !!draftState?.sending || !!draftState?.pendingAttachments;
    // While Pi waits for a typed answer, the message box answers it.
    const answering = !!this.asking(activeId);
    this.sendBtn.classList.toggle("answer", answering);
    this.sendBtn.textContent = answering ? "Answer" : "↑";
    this.sendBtn.title = answering ? "Answer Pi's question" : "Send";
    this.sendBtn.setAttribute("aria-label", answering ? "Answer Pi's question" : "Send message");
    if (answering) this.ta.placeholder = "Type your answer…";
    this.resizeEditor();
  }
}

customElements.define("pi-thread", PiThread);
customElements.define("pi-model-picker", PiModelPicker);
customElements.define("pi-context-meter", PiContextMeter);
customElements.define("pi-thinking-picker", PiThinkingPicker);
customElements.define("pi-composer", PiComposer);

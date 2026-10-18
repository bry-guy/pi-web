import { randomUUID } from "node:crypto";

const DEFAULT_UI_TIMEOUT_MS = 10 * 60 * 1000;

function hostError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function cancelValue(method) {
  return method === "confirm" ? false : undefined;
}

function pendingKey(sessionId, requestId) {
  return `${sessionId}:${requestId}`;
}

/** Bridges pi extension UI (dialogs, status, notices) to the browser over the event hub. */
export class ExtensionUiHost {
  constructor({ hub, supervisor } = {}) {
    this.hub = hub;
    this.supervisor = supervisor;
    this.pending = new Map();
  }

  extensionBindings(sessionId) {
    return {
      mode: "json",
      uiContext: this.uiContext(sessionId),
      commandContextActions: this.commandContextActions(sessionId),
      onError: error => {
        this.hub?.emit(sessionId, "extension_error", {
          extensionPath: error.extensionPath,
          event: error.event,
          error: error.error,
        });
      },
    };
  }

  commandContextActions(sessionId) {
    return {
      waitForIdle: async () => { await this.supervisor?.waitForIdle?.(sessionId); },
      newSession: async options => this.supervisor?.newSessionFromCommand?.(sessionId, options) || { cancelled: true },
      fork: async (entryId, options) => this.supervisor?.forkFromCommand?.(sessionId, entryId, options) || { cancelled: true },
      navigateTree: async (targetId, options) => this.supervisor?.navigateTreeFromCommand?.(sessionId, targetId, options) || { cancelled: true },
      switchSession: async (sessionPath, options) => this.supervisor?.switchSessionFromCommand?.(sessionId, sessionPath, options) || { cancelled: true },
      reload: async () => { await this.supervisor?.reloadSession?.(sessionId); },
    };
  }

  uiContext(sessionId) {
    return {
      select: (title, options, opts) => this.request(sessionId, "select", { title, options }, opts, undefined),
      confirm: (title, message, opts) => this.request(sessionId, "confirm", { title, message }, opts, false),
      input: (title, placeholder, opts) => this.request(sessionId, "input", { title, placeholder: placeholder || "" }, opts, undefined),
      notify: (message, type = "info") => {
        this.hub?.emit(sessionId, "extension_ui_notify", { message: String(message || ""), level: type });
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        this.hub?.emit(sessionId, "extension_ui_status", { key, text: text === undefined ? null : String(text) });
      },
      setWorkingMessage: message => this.hub?.emit(sessionId, "extension_ui_working", { message: message || null }),
      setWorkingVisible: visible => this.hub?.emit(sessionId, "extension_ui_working", { visible: !!visible }),
      setWorkingIndicator: options => this.hub?.emit(sessionId, "extension_ui_working", { indicator: options || null }),
      setHiddenThinkingLabel: label => this.hub?.emit(sessionId, "extension_ui_thinking", { label: label || null }),
      setWidget: (key, content, options) => {
        if (typeof content === "function") return;
        this.hub?.emit(sessionId, "extension_ui_widget", { key, content: content || null, placement: options?.placement || "aboveEditor" });
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: title => this.hub?.emit(sessionId, "extension_ui_title", { title: String(title || "") }),
      custom: async () => undefined,
      pasteToEditor: text => this.hub?.emit(sessionId, "extension_ui_editor", { action: "paste", text: String(text || "") }),
      setEditorText: text => this.hub?.emit(sessionId, "extension_ui_editor", { action: "set", text: String(text || "") }),
      getEditorText: () => "",
      editor: (title, prefill, opts) => this.request(sessionId, "editor", { title, prefill: prefill || "" }, opts, undefined),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: {},
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Browser themes are managed by pi-ez-web." }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  request(sessionId, method, payload, options = {}, fallback) {
    const requestId = randomUUID();
    const key = pendingKey(sessionId, requestId);
    const timeout = Number.isFinite(options?.timeout) && options.timeout > 0 ? options.timeout : DEFAULT_UI_TIMEOUT_MS;
    return new Promise(resolve => {
      let timer;
      let onAbort;
      const finish = value => {
        if (!this.pending.has(key)) return;
        this.pending.delete(key);
        if (timer) clearTimeout(timer);
        if (options?.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      onAbort = () => finish(fallback);
      if (options?.signal?.aborted) return resolve(fallback);
      if (options?.signal) options.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(fallback), timeout);
      timer.unref?.();
      this.pending.set(key, {
        sessionId,
        requestId,
        method,
        finish,
        options: Array.isArray(payload.options) ? payload.options.filter(option => typeof option === "string") : null,
        event: { requestId, method, ...payload, timeout },
      });
      this.hub?.emit(sessionId, "extension_ui_request", { requestId, method, ...payload, timeout });
    });
  }

  respond(sessionId, requestId, value) {
    const key = pendingKey(sessionId, requestId);
    const pending = this.pending.get(key);
    if (!pending) throw hostError("This extension interaction is no longer waiting for a response.", "stale_extension_ui_request");
    const body = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    if (body.cancelled === true) {
      pending.finish(cancelValue(pending.method));
      return { ok: true, cancelled: true };
    }
    if (pending.method === "confirm") {
      if (typeof body.confirmed !== "boolean") throw hostError("A confirmation response is required.", "invalid_extension_ui_response", 400);
      pending.finish(body.confirmed);
      return { ok: true };
    }
    if (pending.method === "select" && (!pending.options || !pending.options.includes(body.value))) {
      throw hostError("The selected extension UI option is invalid.", "invalid_extension_ui_response", 400);
    }
    if (!["select", "input", "editor"].includes(pending.method) || typeof body.value !== "string") {
      throw hostError("A text response is required.", "invalid_extension_ui_response", 400);
    }
    pending.finish(body.value);
    return { ok: true };
  }

  cancel(sessionId, requestId) {
    const pending = this.pending.get(pendingKey(sessionId, requestId));
    if (!pending) throw hostError("This extension interaction is no longer waiting for a response.", "stale_extension_ui_request");
    pending.finish(cancelValue(pending.method));
    return { ok: true, cancelled: true };
  }

  /** Re-sends dialogs still waiting for this session, e.g. after the browser reloads mid-dialog. */
  replayPending(sessionId) {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) this.hub?.emit(sessionId, "extension_ui_request", pending.event);
    }
  }

  cancelSession(sessionId) {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) pending.finish(cancelValue(pending.method));
    }
  }

  close() {
    for (const pending of this.pending.values()) pending.finish(cancelValue(pending.method));
  }
}

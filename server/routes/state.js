import { piSyncState } from "../pi-sync.js";

export function register(api, deps) {
  const { remote, loadBindings, loadConfig, reposRoot, chatsState, projectState, ws, API_CAPABILITIES, API_CONTRACT_VERSION, BUILD_ID, readLogs, logFileName, safe, repositorySourceState, settingsState, github, sup } = deps;


  // ---------- state ----------
  api.get("/health", c => c.json({
    ok: true,
    apiContractVersion: API_CONTRACT_VERSION,
    buildId: BUILD_ID,
    capabilities: API_CAPABILITIES,
    sync: piSyncState(),
    busy: !!sup.busy?.(),
  }));

  api.get("/logs", c => c.json({
    logs: readLogs(c.req.query("limit")),
    file: logFileName(),
  }));

  api.get("/state", async c => {
    const cfg = loadConfig();
    loadBindings();
    const modelState = await safe(() => sup.modelState(), {
      models: [],
      configuredDefault: cfg.defaultModel || null,
      effectiveDefault: null,
      status: cfg.defaultModel ? "unavailable" : "automatic",
      error: { code: "model_runtime_error", message: "Could not load models." },
    });
    const models = modelState.models || [];
    const providers = await safe(() => sup.listProviders(), []);
    const piConfiguration = await safe(() => sup.piConfigurationState(), {
      config: cfg.pi,
      profile: { status: "error", source: cfg.pi.profile, error: "Could not inspect Pi configuration." },
      warnings: [],
      runtime: null,
    });
    const projects = [];
    for (const p of cfg.projects) {
      try { projects.push(await projectState(p, sup)); }
      catch (e) { projects.push({ id: p.id, name: p.name, repoPath: p.repoPath, defaultBranch: await ws.defaultBranchAsync(p.repoPath), error: String(e.message || e), branches: [], sessions: [], contexts: [], worktrees: {}, workspaceStatus: {} }); }
    }
    const remoteState = remote ? await remote.refresh() : null;
    let chats = remoteState ? remoteState.chats : await chatsState(sup);
    // Until web's earlier chats have moved to the chats worker, web still lists and serves them.
    if (remoteState && remote.localChatsPending()) {
      const moved = new Set(chats.map(chat => chat.id));
      chats = [...chats, ...(await chatsState(sup)).filter(chat => !moved.has(chat.id))]
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }
    return c.json({
      apiContractVersion: API_CONTRACT_VERSION,
      buildId: BUILD_ID,
      capabilities: API_CAPABILITIES,
      mode: process.env.PI_WEB_MODE || "real",
      defaultModel: modelState.configuredDefault,
      defaultThinkingLevel: cfg.defaultThinkingLevel,
      effectiveDefaultModel: modelState.effectiveDefault,
      defaultModelStatus: modelState.status,
      modelError: modelState.error || null,
      models,
      providers,
      piConfiguration,
      repositorySources: repositorySourceState(cfg, github),
      settings: settingsState(cfg, github),
      sync: piSyncState(),
      reposRoot: reposRoot(cfg),
      reposRootSource: process.env.PI_WEB_REPOS_ROOT ? "environment" : cfg.reposRoot ? "config" : "default",
      projects: remoteState ? remoteState.projects : projects,
      chats,
    });
  });

  api.get("/models", async c => {
    const state = await sup.modelState();
    return c.json({ models: state.models, error: state.error || null });
  });

  api.get("/providers", async c => c.json({ providers: await sup.listProviders() }));

  api.get("/repository-sources", c => c.json(repositorySourceState(loadConfig(), github)));
}

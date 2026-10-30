import { piSyncState } from "../pi-sync.js";
import { saveConfig } from "../config.js";
import { listPiProjects, piProjectsDir, reconcile } from "../pi-projects.js";

export function register(api, deps) {
  const { remote, loadBindings, loadConfig, reposRoot, chatsListing, projectState, folderState, ws, API_CAPABILITIES, API_CONTRACT_VERSION, BUILD_ID, readLogs, logFileName, safe, repositorySourceState, settingsState, github, sup } = deps;


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
    // pi projects' project.json files decide which of their repositories are projects here.
    if (!remote && reconcile(cfg)) saveConfig(cfg);
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
    const remoteState = remote ? await remote.refresh() : null;
    const piConfiguration = remoteState?.piConfiguration || await safe(() => sup.piConfigurationState(), {
      config: cfg.pi,
      profile: { status: "error", source: cfg.pi.profile, error: "Could not inspect Pi configuration." },
      warnings: [],
      runtime: null,
    });
    // With workers, every project and chat lives in one; web lists only what they report.
    const projects = [];
    if (!remoteState) for (const p of cfg.projects) {
      try { projects.push(await projectState(p, sup)); }
      catch (e) { projects.push({ id: p.id, name: p.name, repoPath: p.repoPath, defaultBranch: await ws.defaultBranchAsync(p.repoPath), error: String(e.message || e), branches: [], sessions: [], contexts: [], worktrees: {}, workspaceStatus: {} }); }
    }
    // Each pi project's own folder is listed like a repository, so its sessions need no repository.
    if (!remoteState) for (const group of listPiProjects()) projects.push(await folderState(group, sup));
    const { chats, ended: endedChats } = remoteState || await chatsListing(sup);
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
      // pi projects this server serves (none behind workspaced: each worker reports its own projects' groups).
      // Behind workspaced every new project gets its own worker; locally only with PI_PROJECTS_DIR.
      piProjectsEnabled: !!remoteState || !!piProjectsDir(),
      // Behind workspaced, web lists a pi project's other-device conversations itself (no worker needed).
      piProjectsSyncedRoute: !!remoteState,
      piProjects: remoteState ? remoteState.piProjects || [] : listPiProjects().map(({ name, path, repos }) => ({ name, path, repos })),
      chats,
      endedChats: endedChats || [],
    });
  });

  api.get("/models", async c => {
    const state = await sup.modelState();
    return c.json({ models: state.models, error: state.error || null });
  });

  api.get("/providers", async c => c.json({ providers: await sup.listProviders() }));

  api.get("/repository-sources", c => c.json(repositorySourceState(loadConfig(), github)));
}

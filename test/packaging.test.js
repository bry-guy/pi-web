import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

test("production image installs the Pi SDK and browser Markdown libraries as runtime dependencies", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const piSyncCommit = fs.readFileSync(path.join(root, "PI_SYNC_COMMIT"), "utf8").trim();
  const runtimeDependencies = ["@earendil-works/pi-coding-agent", "dompurify", "highlight.js", "marked"];

  for (const dependency of runtimeDependencies) {
    assert.ok(pkg.dependencies[dependency], `${dependency} must be a production dependency`);
    assert.equal(pkg.devDependencies?.[dependency], undefined);
    assert.equal(pkg.peerDependencies?.[dependency], undefined);
    assert.equal(lock.packages[""].dependencies[dependency], pkg.dependencies[dependency]);
    assert.notEqual(lock.packages[`node_modules/${dependency}`].dev, true);
  }
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /ARG PI_WEB_BUILD_ID/);
  assert.match(piSyncCommit, /^[0-9a-f]{40}$/, "pi-sync is pinned to one full commit");
  assert.doesNotMatch(dockerfile, /PI_SYNC_BASE_COMMIT|vendor\//);
  assert.match(dockerfile, /COPY PI_SYNC_COMMIT/);
  assert.match(dockerfile, /RUN \.\/scripts\/install-pi-sync\.sh/);
  assert.equal(pkg.scripts.pretest, "scripts/install-pi-sync.sh");
  assert.equal(fs.existsSync(path.join(root, "vendor")), false, "pi-sync is installed from its own repository, not copied");
  assert.doesNotMatch(dockerfile, /git clone/);
  // mise and yadm are credential-free prestart tools; secret and cluster tools stay out.
  assert.match(dockerfile, /install -m 0755 "\$tmp\/mise" \/usr\/local\/bin\/mise/);
  assert.match(dockerfile, /install -m 0755 "\$tmp\/yadm-3\.5\.0\/yadm" \/usr\/local\/bin\/yadm/);
  assert.doesNotMatch(dockerfile, /\b(fnox|tofu|kubectl)\b/i);
  assert.doesNotMatch(dockerfile, /\bop\b/);
  assert.doesNotMatch(dockerfile, /MISE_|FNOX_|OP_VERSION|OPENTOFU_|KUBECTL_/);
  assert.match(dockerfile, /build-essential/);
  assert.match(dockerfile, /openssh-client/);
  assert.match(dockerfile, /pi-ez-web-git-credential-helper/);
  assert.match(dockerfile, /server\/git-credential-helper\.js "\$@"/);
  assert.match(dockerfile, /git config --system credential\.https:\/\/github\.com\.helper \/usr\/local\/bin\/pi-ez-web-git-credential-helper/);
  assert.equal(pkg.dependencies["@1password/sdk"], undefined);
  assert.equal(lock.packages[""].dependencies["@1password/sdk"], undefined);
  assert.equal(lock.packages["node_modules/@1password/sdk"], undefined);
  assert.equal(lock.packages["node_modules/@1password/sdk-core"], undefined);
  assert.equal(fs.existsSync(path.join(root, "server/onepassword.js")), false);
  assert.doesNotMatch(dockerfile, /1password|onepassword/i);
  assert.doesNotMatch(dockerfile, /not-a-real-service-account-token/);
  assert.doesNotMatch(dockerfile, /npm install --no-save/);
});

test("local packaging installs pinned pi-sync and supports browser checks", () => {
  const pkg = readJson("package.json");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

  assert.equal(pkg.main, undefined);
  assert.equal(pkg.scripts.browser, "playwright open");
  assert.match(fs.readFileSync(path.join(root, "scripts/install-pi-sync.sh"), "utf8"), /codeload\.github\.com\/bry-guy\/pi-sync/);
  assert.match(dockerfile, /rm -rf \.cache/);
  assert.match(gitignore, /^node_modules$/m);
  assert.match(gitignore, /^\.cache\/$/m);
  assert.match(gitignore, /^\.pi\/validation\/$/m);
  assert.doesNotMatch(gitignore, /^\.pi\/?$/m);
  assert.match(dockerignore, /^\.cache\/$/m);
  assert.ok(readme.includes("PORT=3141 npm run dev"));
  assert.ok(readme.includes('npm run browser -- --device="iPhone 13" http://localhost:3141'));
});

test("project hook capability is advertised by the server", () => {
  const version = fs.readFileSync(path.join(root, "server/version.js"), "utf8");
  assert.match(version, /project-hooks/);
});

test("self-hosting examples keep state persistent and secrets out of defaults", () => {
  const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
  const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const config = readJson("config.example.json");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const deployment = fs.readFileSync(path.join(root, "docs/deployment.md"), "utf8");
  const configuration = fs.readFileSync(path.join(root, "docs/configuration.md"), "utf8");

  assert.match(compose, /context: \./);
  assert.ok(compose.includes("${PI_WEB_BIND_ADDRESS:-127.0.0.1}:${PI_WEB_PORT:-3141}:3141"));
  assert.match(compose, /pi-ez-web-data:\/data/);
  assert.doesNotMatch(compose, /^\s+name: pi-ez-web-data$/m);
  assert.match(compose, /PI_WEB_HOME: \/data\/pi-ez-web/);
  assert.match(compose, /PI_CODING_AGENT_DIR: \/data\/pi-ez-agent/);
  assert.match(compose, /PI_WEB_REPOS_ROOT: \/data\/repos/);
  assert.match(compose, /http:\/\/127\.0\.0\.1:3141\/ui-health/);
  assert.match(envExample, /PI_WEB_BIND_ADDRESS=127\.0\.0\.1/);
  assert.equal(config.projects.length, 0);
  assert.equal(config.pi.profile, null);
  assert.equal(config.pi.profileSource, "disabled");
  assert.equal(config.sync.serverUrl, null);
  assert.doesNotMatch(JSON.stringify(config), /token|secret|password|credential/i);

  for (const text of [readme, deployment, configuration]) {
    assert.doesNotMatch(text.replace(/https:\/\/github\.com\/bry-guy\/(pi-ez-web|pi-sync)|ghcr\.io\/bry-guy\/pi-ez-web/g, ""), /Node(?:\.js)? 20|temporary askpass|preview deployment|bry-guy|fnox|OP_SERVICE_ACCOUNT_TOKEN/i);
  }
  assert.match(readme, /docker compose up --build -d/);
  assert.match(readme, /Projects → Git URL/);
  assert.match(readme, /PI_WEB_PORT/);
  assert.match(configuration, /You do not need a config file to start/);
  assert.match(configuration, /Compose `.env` file controls Compose interpolation only/);
  assert.match(configuration, /If a source variable is missing, the command does not start/);
  assert.match(configuration, /set -e/);
  assert.match(configuration, /`\/data\/pi-ez-operator-home\/.pi\/worktrees`/);
  assert.match(deployment, /one named\s+volume/);
  assert.match(deployment, /project-scoped/);
  assert.match(deployment, /restore_volume="\$\(docker volume create\)"/);
  assert.match(deployment, /external: true/);
  assert.match(deployment, /Bare `docker compose` selects the original volume again/);
  assert.match(deployment, /export COMPOSE_FILE=compose\.yaml:compose\.restore\.yaml/);
});

test("image publication workflow publishes immutable GHCR images", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/publish-image.yml"), "utf8");
  const testsJob = workflow.match(/^  tests:\n([\s\S]*?)(?=^  publish:)/m)?.[1];

  assert.ok(testsJob);
  assert.match(testsJob, /    permissions:\n      contents: read\n    steps:/);
  assert.match(testsJob, /uses: actions\/checkout@v4[\s\S]*?ref: \$\{\{ github\.sha \}\}/);
  assert.match(testsJob, /uses: actions\/setup-node@v4[\s\S]*?node-version: 22[\s\S]*?cache: npm[\s\S]*?cache-dependency-path: package-lock\.json/);
  assert.match(testsJob, /run: npm ci[\s\S]*?run: npm test/);
  assert.doesNotMatch(workflow, /^  publish:\n    needs:/m, "publish runs alongside tests, not after them");
  assert.match(workflow, /permissions:\n  contents: read\n  packages: write\n/);
  const publishJob = workflow.match(/^  publish:\n([\s\S]*?)(?=^  deploy:)/m)?.[1];
  assert.ok(publishJob);
  assert.doesNotMatch(publishJob, /contents: write|id-token: write|git push/);
  assert.match(workflow, /group: pi-ez-web-image-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /docker\/login-action/);
  assert.match(workflow, /tag="sha-\$\{source_sha\}"/);
  assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(workflow, /PI_WEB_BUILD_ID=\$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(publishJob, /digest: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(publishJob, /cache-from: type=gha,scope=pi-ez-web/);
});

test("deploy job pins the built digest and gates production on main", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/publish-image.yml"), "utf8");
  const deployJob = workflow.match(/^  deploy:\n([\s\S]*)/m)?.[1];
  assert.ok(deployJob);
  assert.match(deployJob, /needs: \[tests, publish\]/);
  assert.match(deployJob, /DIGEST: \$\{\{ needs\.publish\.outputs\.digest \}\}/);
  assert.match(deployJob, /cancel-in-progress: false/);
  assert.match(deployJob, /run: \.\.\/src\/scripts\/deploy\.sh preview/);
  assert.match(deployJob, /if: github\.ref == 'refs\/heads\/main'\n        working-directory: main\n        run: \.\.\/src\/scripts\/deploy\.sh production/);
});

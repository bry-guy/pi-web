#!/usr/bin/env bash
# Pin $DIGEST (built from $SHA) in deploy/k8s, push to main, and wait until the
# environment serves $SHA. Argo CD syncs deploy/k8s from main.
# Usage: SHA=<commit> DIGEST=sha256:<hex> scripts/deploy.sh preview|production
set -euo pipefail

env_name="${1:?usage: deploy.sh preview|production}"
case "$env_name" in
  preview) files=(deploy/k8s/preview/kustomization.yaml); url=https://pi.preview.bry-guy.net/ui-health ;;
  # Web and the workspaced gateway (and its WORKSPACE_IMAGE) move together.
  production) files=(deploy/k8s/web/kustomization.yaml deploy/k8s/workspaced/kustomization.yaml); url=https://pi.bry-guy.net/ui-health ;;
  *) echo "unknown environment: $env_name" >&2; exit 2 ;;
esac
[[ "${DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "DIGEST must be sha256:<64 hex>" >&2; exit 2; }
[[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "SHA must be a 40-character commit SHA" >&2; exit 2; }

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3 4 5; do
  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  for f in "${files[@]}"; do
    sed -i -E "s|digest: sha256:[0-9a-f]{64}|digest: $DIGEST|" "$f"
  done
  if git diff --quiet; then
    echo "$env_name already pins $DIGEST"
    break
  fi
  git commit --quiet -m "deploy($env_name): ${SHA:0:7}" -m "Source: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/commit/$SHA" -- "${files[@]}"
  if git push --quiet origin HEAD:main; then
    echo "Pushed $env_name pin for ${SHA:0:7}"
    # Best-effort: Argo CD refreshes now instead of at its next 30s poll.
    curl -fsS -m 10 -X POST https://argocd-hook.bry-guy.net/api/webhook -H 'Content-Type: application/json' -H 'X-GitHub-Event: push' -d "{\"ref\":\"refs/heads/main\",\"after\":\"$(git rev-parse HEAD)\",\"repository\":{\"html_url\":\"https://github.com/$GITHUB_REPOSITORY\",\"default_branch\":\"main\"},\"commits\":[]}" >/dev/null || echo "argo webhook unavailable; Argo will poll"
    break
  fi
  [ "$attempt" -lt 5 ] || { echo "could not push the $env_name pin" >&2; exit 1; }
  sleep $((attempt * 3))
done

# The webhook above usually beats Argo's 30s Git poll; allow 10 minutes for pickup plus rollout.
for _ in $(seq 1 200); do
  build="$(curl --fail --silent --connect-timeout 5 --max-time 10 "$url" | jq -r '.buildId // empty' || true)"
  if [ "$build" = "$SHA" ]; then
    echo "$env_name is serving ${SHA:0:7}"
    exit 0
  fi
  sleep 3
done
echo "$env_name did not serve ${SHA:0:7} within 10 minutes (last: ${build:-unreachable}); check Argo CD" >&2
exit 1

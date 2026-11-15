#!/usr/bin/env bash
# The gate: may this @tess-review comment start a review, and which commit does that review read?
# The workflow's `gate` job runs this from `main`, and its answers decide whether the `review` job exists at all, so every
# path here fails closed. The answers are written once, by the exit trap, so an unexpected error leaves the review off
# instead of half-started.
#
# Why a script and not inline YAML: a fork's head must never reach a job that holds a provider key, and that rule is worth
# a test (tools/test-agent-review.mjs runs this file with a fake `gh`).
set -euo pipefail
cd "$(dirname "$0")/.."

allowed=false
role=""
head_sha=""
tier="sensitive"
number="${ISSUE_NUMBER:-0}"
repository="${REPOSITORY:?REPOSITORY is required}"

finish() {
  {
    echo "allowed=$allowed"
    echo "role=$role"
    echo "number=$number"
    echo "head_sha=$head_sha"
    echo "tier=$tier"
  } >> "${GITHUB_OUTPUT:-/dev/stdout}"
}
trap finish EXIT

# The reviewer's own comments carry this marker; they never re-trigger a review.
case "${COMMENT_BODY:-}" in
  *"<!-- tess-review-bot -->"*) exit 0 ;;
esac

# Only the listed accounts may ask, and a login is compared whole (no prefix or case matching).
caller_allowed=false
IFS=',' read -ra accounts <<< "${AGENT_ALLOWLIST:-}"
for account in "${accounts[@]}"; do
  account="${account#"${account%%[![:space:]]*}"}"
  account="${account%"${account##*[![:space:]]}"}"
  if [[ -n "$account" && "$account" == "${COMMENTER:-}" ]]; then
    caller_allowed=true
    break
  fi
done
[[ "$caller_allowed" == true ]] || exit 0

role="$(printf '%s\n' "${COMMENT_BODY:-}" | awk '/^@tess-review (approach|pr)([[:space:]]|$)/ { print $2; exit }')"
case "$role" in
  approach|pr) ;;
  *) role=""; exit 0 ;;
esac

if [[ "$role" == "pr" ]]; then
  # An issue comment and a pull-request comment arrive the same way; only a pull request has somewhere to review.
  pr_url="$(gh api "repos/$repository/issues/$number" --jq '.pull_request.url // empty')"
  [[ -n "$pr_url" ]] || exit 0

  # One read gives the commit to review and whether that commit is this repository's own branch. A fork author writes
  # the diff and the snapshot the reviewer would read, and the review job holds a provider key, so a fork's head is
  # refused even when an allowlisted maintainer tagged it and its CI is green. The decision is Node, not a jq filter:
  # jq's `//` treats `false` as missing, so `(.head.repo.fork // true)` turned a real `fork: false` into "not ours" and
  # refused every ordinary pull request. The same function decides it inside the review, so both doors agree, and
  # `tools/test-agent-review.mjs` drives it with the JSON GitHub really returns.
  facts="$(gh api "repos/$repository/pulls/$number" | node tools/agent-review.mjs head "$repository")"
  read -r head_verdict head_sha <<< "$facts"
  # Fail closed: a deleted head repository, an empty answer, a missing `fork` flag and a missing commit all refuse.
  if [[ "$head_verdict" != "review" || -z "$head_sha" || "$head_sha" == "-" ]]; then
    head_sha=""
    exit 0
  fi

  # CI has to have passed on exactly this commit. Any later push changes the head, and the review re-checks it as well.
  conclusion="$(gh api "repos/$repository/actions/workflows/check.yml/runs?head_sha=$head_sha&event=pull_request&per_page=100" \
    --jq '.workflow_runs | sort_by(.created_at) | reverse | .[0].conclusion // ""')"
  [[ "$conclusion" == "success" ]] || exit 0

  tier="$(gh api "repos/$repository/pulls/$number/files" --paginate --jq '.[].filename' |
    node tools/agent-review.mjs tier)"
  case "$tier" in
    docs|normal|sensitive) ;;
    *) tier="sensitive" ;;
  esac
fi

allowed=true

#!/usr/bin/env bash
# The gate: may this @tess-review comment start a review, where does it run, and which commit does that review read?
# The workflow's `gate` job runs this from `main`, and its answers decide whether the `review` job exists at all, so every
# path here fails closed. The answers are written once, by the exit trap, so an unexpected error leaves the review off
# instead of half-started.
#
# Why a script and not inline YAML: a fork's head must never reach a job that holds a provider key, the machine a tag
# names decides which job runs at all, and both rules are worth a test (tools/test-agent-review.mjs runs this file with a
# fake `gh`).
set -euo pipefail
cd "$(dirname "$0")/.."

allowed=false
role=""
head_sha=""
tier="sensitive"
machine=""
# A refusal code is a fixed text the notice job posts (tools/agent-review.mjs `reviewRefusals`). Silence is a code too:
# a comment from an account that is not allowlisted, or one with no tag, is answered with nothing at all.
refusal=""
number="${ISSUE_NUMBER:-0}"
repository="${REPOSITORY:?REPOSITORY is required}"

finish() {
  {
    echo "allowed=$allowed"
    echo "role=$role"
    echo "number=$number"
    echo "head_sha=$head_sha"
    echo "tier=$tier"
    echo "machine=$machine"
    echo "refusal=$refusal"
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

# Where the tag goes, and whether its options are the ones a tag takes (`machine=`, a quoted `prompt=`). Node reads the
# tag because the quoting, the cap and the refused machines are rules, not a regex in YAML: one line back, `github -`,
# `mac -`, `omarchy -` or `refuse <code>`, so a tag cannot be accepted by one door and refused by the other.
route="$(printf '%s\n' "${COMMENT_BODY:-}" | node tools/agent-review.mjs route)"
read -r route_kind route_value <<< "$route"
case "$route_kind" in
  github|mac|omarchy) machine="$route_kind" ;;
  refuse)
    if [[ "$route_value" == "machine-vps" || "$route_value" == "invalid-options" ]]; then
      refusal="$route_value"
    else
      refusal="invalid-options"
    fi
    exit 0
    ;;
  *)
    # An answer this script does not understand is not a reason to run a review.
    refusal="invalid-options"
    exit 0
    ;;
esac

if [[ "$role" == "pr" ]]; then
  # An issue comment and a pull-request comment arrive the same way; only a pull request has somewhere to review.
  pr_url="$(gh api "repos/$repository/issues/$number" --jq '.pull_request.url // empty')"
  if [[ -z "$pr_url" ]]; then
    refusal="not-a-pull-request"
    exit 0
  fi

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
    refusal="fork-pr"
    exit 0
  fi

  # CI has to have passed on exactly this commit. Any later push changes the head, and the review re-checks it as well.
  # A tag for a machine is held to the same rule, because that machine's watcher reads the same commit.
  conclusion="$(gh api "repos/$repository/actions/workflows/check.yml/runs?head_sha=$head_sha&event=pull_request&per_page=100" \
    --jq '.workflow_runs | sort_by(.created_at) | reverse | .[0].conclusion // ""')"
  if [[ "$conclusion" != "success" ]]; then
    refusal="ci-not-passed"
    exit 0
  fi

  tier="$(gh api "repos/$repository/pulls/$number/files" --paginate --jq '.[].filename' |
    node tools/agent-review.mjs tier)"
  case "$tier" in
    docs|normal|sensitive) ;;
    *) tier="sensitive" ;;
  esac
fi

allowed=true

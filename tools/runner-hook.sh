#!/bin/sh
# The dispatcher runner's job-started hook: set as ACTIONS_RUNNER_HOOK_JOB_STARTED in the .env of each runner
# instance that belongs to the tess-dispatch user.
#
# That user holds the T3 outside-agent credential, which can start full agent threads on the machines that keep Tess
# keys. So the credential must not be reachable from any other job. A same-repository pull request can add a workflow
# with `runs-on: [self-hosted, tess-dispatch]` and read whatever the runner's jobs can read; fork approval does not
# cover branches in this repository. This hook is the boundary: a job starts only when it is an issue_comment run of
# this one workflow file from main. Anything else, and anything it cannot identify, exits non-zero and the job never
# runs.
#
# Copy this file to the runner host (for example ~/.local/bin/tess-dispatch-hook.sh) and keep it in step with the
# repository copy. Verify it after changing it: a job from any other workflow must fail to start. See runner-setup.md.
set -eu

event="${GITHUB_EVENT_NAME:-}"
workflow_ref="${GITHUB_WORKFLOW_REF:-}"
allowed="Flame119052/tess-music/.github/workflows/agent-dispatch.yml@refs/heads/main"

if [ "$event" != "issue_comment" ] || [ "$workflow_ref" != "$allowed" ]; then
  echo "tess-dispatch: refusing this job (event=${event:-unknown}, workflow=${workflow_ref:-unknown})" >&2
  echo "tess-dispatch: only ${allowed} may run on this runner" >&2
  exit 1
fi

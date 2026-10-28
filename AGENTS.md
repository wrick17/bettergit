## Live app window
- When starting work on this repo, stop the release build and start a dev build. Keep exactly one BetterGit dev window running the latest completed change or merge so the user can check progress live.
- Renderer-only changes: let the dev server reload the window. Main or preload changes: quit and relaunch BetterGit with the same command it was started with.
- Keep exactly one BetterGit window. Never open a second instance or leave stale BetterGit processes running; kill only BetterGit processes.
- When work happens in a separate worktree, update the window at verified checkpoints and say whether it is running master or the worktree branch.

## Pull requests
- Every change reaches master through a GitHub pull request against master. Never merge locally into master or push directly to master.
- Push the work branch, open the PR with `gh pr create`, wait for PR checks, then merge with `gh pr merge --merge --delete-branch`, which keeps the repo's "Merge pull request #N" history.
- After the merge, fast-forward local master, then remove the finished worktree and local branch.

## Releases
- Before pushing a `v<version>` tag, add a `## [<version>] - <date>` section to CHANGELOG.md in the release PR. List user-visible changes under New, Improved, Changed or Fixed. The Release workflow publishes that section as the GitHub Release notes and fails without it.
- Once a release is ready, stop the dev build, install the new BetterGit version in `~/Applications`, and open the final installed build with exactly one window.

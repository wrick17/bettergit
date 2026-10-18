## Live app window
- Keep the user's one open BetterGit window running the latest code after every change (each implementation step, fix, or merge) so they can check progress live.
- Renderer-only changes: let the dev server reload the window. Main or preload changes: quit and relaunch BetterGit with the same command it was started with.
- Keep exactly one BetterGit window. Never open a second instance or leave stale BetterGit processes running; kill only BetterGit processes.
- When work happens in a separate worktree, update the window at verified checkpoints and say whether it is running master or the worktree branch.

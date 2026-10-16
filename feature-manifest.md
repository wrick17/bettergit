# BetterGit Feature Manifest

Date: 2026-10-16

## Summary

BetterGit is a private, Mac-only Git desktop client. It runs on Electron 44, React 19, and TypeScript, built with electron-vite 6 and Vite 8. Git runs through the git CLI as subprocesses. The app has a multi-repo sidebar, staged and unstaged changes with commit, unified and split diffs, a commit graph with commit actions, stash and pull/push/reset actions, background fetch while the user is active, and live file watching. Config is a JSON file in the Electron userData folder. Session restore, independent panel toggles, sidebar Settings, Lucide action icons, vscode-icons folders, move-note rows, and parsed commit stats are wired. Styling cleanup is partly complete; the custom dev watcher is still missing. All app behavior is code verified, not run. The 20 tests across 3 files and typecheck pass in this documentation refresh.

Status key: **done** (implementation found in code), **partial** (some parts found, others missing), **in progress** (requested work is incomplete or not wired into the app), **backend only** (helper or IPC exists without a UI action), **planned** (not found), **unverified** (claimed, not confirmed), **not supported** (excluded by current behavior).

Every feature-row status is code verified, not run in the app. Planned and unsupported rows describe source absences or limits; performance and visual quality remain unmeasured. Command results are recorded separately below.

## Feature table

### Sidebar and repos

| Area | Feature | Status | Evidence |
|---|---|---|---|
| Sidebar | Add folder via dialog, multi-select | done | `src/main/index.ts` (`sources:pick`), `src/renderer/src/Sidebar.tsx` (Add menu) |
| Sidebar | Drop a folder onto the sidebar | done | `src/renderer/src/App.tsx` (`handleDrop`), `src/preload/index.ts` (`pathForFile`) |
| Sidebar | Clone from URL | done | `src/renderer/src/Dialogs.tsx` (`CloneDialog`), `src/main/index.ts` (`clone`), `src/main/git/ops.ts` (`clone`) |
| Sidebar | Recursive folder scan shown as tree | done | `src/main/scan.ts` (`scanFolder`, `scanChildren`), `src/renderer/src/Sidebar.tsx` (`TreeItem`) |
| Scan | Skip `node_modules` and dot-directories | done | `src/main/scan.ts` (`SKIPPED_DIRECTORIES`, `startsWith('.')`) |
| Scan | Skip symlink entries during recursive descent | done | `src/main/scan.ts` (`entry.isDirectory()` check, comment) |
| Scan | Do not descend into a found repo | done | `src/main/scan.ts` (repos are leaves) |
| Scan | Prune empty descendants; retain explicitly added empty roots | done | `src/main/scan.ts` (`scanChildren`, `if (!children.length) return null`); `index.ts` (`buildTree`) keeps a placeholder for an empty source |
| Sidebar | Hide repo or folder, persisted in config | done | `src/main/config.ts` (`hidden`), `src/renderer/src/Sidebar.tsx` (eye toggle and context menu) |
| Sidebar | Show hidden repos toggle | done | `src/renderer/src/Sidebar.tsx` (`showHidden`) |
| Sidebar | Collapse and expand folders, persisted in config | done | `src/main/config.ts` (`collapsed`), `Sidebar.tsx` (`onToggleCollapsed`) |
| Sidebar | Remove from sidebar never deletes files | done | `src/main/index.ts` (`sources:remove` only persists config) |
| Sidebar | Reveal in Finder | done | `src/main/index.ts` (`repo:reveal`), `Sidebar.tsx` context menu |
| Sidebar | Show current branch, or short hash when detached | done (code verified, not run) | `src/main/git/head.ts` (`readHead`, reads HEAD file, no git spawn), `Sidebar.tsx` (`repo-branch`) |
| Sidebar | Uncommitted-count pill per repo, background concurrency 4 | done | `src/main/git/dirty.ts` (`DirtyCounter`), `index.ts` invalidates on watcher events and sends `repos:dirty`; preload, `App.tsx`, and `Sidebar.tsx` connect the event to `.repo-dirty` |
| Sidebar | Folder and repo icons use vscode-icons data URIs | done (code verified, not run) | `Sidebar.tsx` calls `FileIcon.tsx` (`FolderIcon`); `file-icons.ts` contains default/open and git-folder variants; runtime visuals unverified |
| Sidebar | Visible Settings button | done (code verified, not run) | `Sidebar.tsx` renders settings `IconButton`; `App.tsx` passes `onSettings` to open `SettingsDialog`; native Cmd+, also remains |
| Sidebar | Keyboard-reachable rows and focus-visible hide controls | done | `Sidebar.tsx` gives rows `tabIndex=0`, ArrowUp/ArrowDown focus movement, Enter/Space activation; `styles.css` shows `.row-tools` on `:focus-within` |
| Sidebar | Context menu kept inside the window | done | `Sidebar.tsx` measures `contextRef` in `useLayoutEffect` and clamps left/top against window dimensions |
| Sidebar | Groups UI | planned | `RepoGroup` type and `groups` field exist in `src/main/config.ts`; no UI or IPC |
| Sidebar | Scale to about 1,000 repos | unverified | Design uses HEAD file reads; no timing measurement found |

### Changes and diffs

| Area | Feature | Status | Evidence |
|---|---|---|---|
| Changes | Staged, unstaged, conflict groups | done | `src/renderer/src/ChangesView.tsx` (`staged`, `unstaged`, `conflicted`) |
| Changes | Stage and unstage per file | done | `src/main/git/ops.ts` (`stagePaths`, `unstagePaths`), `ChangesView.tsx` (checkbox) |
| Changes | Discard with confirm and Trash2 button in list and tree | done | `ChangesView.tsx` shares `FileRow` across `Group` and `Tree`; unstaged tracked rows use `icon="trash"`, pending label and disable guard; `Icons.tsx` maps Trash2; `ops.ts` (`discardPaths`) |
| Changes | Commit with Cmd+Enter | done | `ChangesView.tsx` (`onKeyDown`, `metaKey`), `src/main/git/ops.ts` (`commit`) |
| Changes | Untracked files shown as added in Unstaged | done | `src/main/git/diff.ts` (`untrackedFiles`), `src/main/git/status.ts` (`'?'` records) |
| Changes | Status letters M/A/D/R/U/!, plus C/T | done | `ChangesView.tsx` (`badge`): U is untracked, ! is unmerged; `DiffView.tsx` (`STATUS_LETTER`) uses M/A/D/R |
| Changes | Per-file +/- counts; folders show changed-file counts | done | `ChangesView.tsx` (`countStats`, `buildTree`, `folder-count`); folder rows have no line totals |
| Changes | List and Tree views, persisted in localStorage | done | `ChangesView.tsx` (`Group`, `Tree`, `VIEW_KEY = bettergit.changesView`) |
| Changes | Constant staging checkbox names | done | `ChangesView.tsx` (`FileRow`) and `DiffView.tsx` (`FileHeader`) use `Stage <path>` regardless of checked state |
| Changes | Omit empty list groups and show Working tree clean | done | `ChangesView.tsx` (`Group`, `Tree`) return null for empty changes; clean copy appears in detail with no selection; empty Staged/Unstaged diff headings remain when other changes exist |
| Changes | Commit drafts survive repo and tab switching | done | `ChangesView.tsx` module-level `drafts` Map is keyed by repo, cleared on successful commit or empty input; drafts do not survive renderer reload |
| Changes | Change-tree folder icons use vscode-icons | done | `ChangesView.tsx` (`TreeLevel`) renders `FolderIcon open={expanded}` from `FileIcon.tsx` |
| Diff | Unified diff by default; layout persisted | done | `src/renderer/src/DiffView.tsx` (`UnifiedLine`, `LAYOUT_KEY = bettergit.diffLayout`, `setDiffLayout`) |
| Diff | Split diff | done | `DiffView.tsx` (`toRows`, `SplitCell`) |
| Diff | Per-file context widening with + rows above and below each hunk | done | `DiffView.tsx` (`ExpandRow`), `ChangesView.tsx` (`expandFile`, `widen`), `src/main/git/diff.ts` (`workingDiff` path filter); each click widens the whole file |
| Diff | Global context toggle (history view) | done | `DiffView.tsx` (`context-toggle`, shown when no `onExpand`), `src/renderer/src/prefs.ts` |
| Diff | Lock files and diffs over 400 changed lines start collapsed | done | `DiffView.tsx` (`startsCollapsed`, `LARGE_DIFF_LINES = 400`, `GENERATED_NAMES`); users can expand each file |
| Diff | Moved-code detection (trimmed lines, min 3) | done | `src/main/git/diff.ts` (`detectMoves`, `MIN_MOVED_LINES`) |
| Diff | Move notes occupy separate rows above code | done | `DiffView.tsx` (`indexMoves`, `UnifiedLine`, split-row fragments) renders `.move-note` outside code cells, with "moved to line N" / "moved from line N" or the other file path |
| Diff | Plain SVG move connectors in split view only | done | `DiffView.tsx` measures `data-move-id` cells with `ResizeObserver` and draws cubic paths with no arrowheads; unified layout clears connectors; geometry remains visually unverified |
| Diff | Long code lines wrap in both layouts | done | `styles.css` (`.line code`, `.split-cell code`) uses `white-space: pre-wrap`, `overflow-wrap: anywhere`, and `min-width: 0` |
| Diff | Sticky toolbar and file headers below it | done | `styles.css` sets `--diff-toolbar-height: 40px`; `.diff-toolbar` sticks at top 0 and `.diff-file > header` at that height |
| Diff | Arrow jump chip for off-screen targets | planned | No code found |
| Diff | Shiki 4.5.0 with GitHub light/dark themes and CSS token colours | done | `bun.lock` (`shiki@4.5.0`), `highlight.ts` (`github-light`, `github-dark`), `DiffView.tsx` and `styles.css` (`--tok-light`, `--tok-dark`) |
| Diff | JavaScript regex engine (no WebAssembly) | done | `highlight.ts` (`createJavaScriptRegexEngine`), `src/renderer/index.html` (CSP) |
| Diff | Extension-to-language map with overrides | done | `highlight.ts` (`DEFAULT_LANGUAGES`), `src/renderer/src/Dialogs.tsx` (`parseLanguages`), `src/main/config.ts` (`languages`) |
| Diff | Highlight cache | done | `highlight.ts` (`cache`, `CACHE_LIMIT`) |
| Diff | Skip highlighting above 400k chars | done | `highlight.ts` (`MAX_HIGHLIGHT_CHARS`) |
| Diff | Git stdout guard at 64 MiB, fails rather than truncates | done | `src/main/git/exec.ts` (`DEFAULT_MAX_BUFFER`); kills the child and rejects on excess output |
| Diff | vscode-icons file-type icons, rendered as SVG data URIs | done | `src/renderer/src/file-icons.ts` embeds the MIT notice and icon set; `FileIcon.tsx` maps names/extensions and renders an encoded data URI in Changes file rows |
| Diff | Shared context preference, 3 / 10 / 25 / All | done | `src/renderer/src/prefs.ts` (`CONTEXT_OPTIONS`, `bettergit.contextLines`); Changes uses this baseline plus per-file widening; History exposes the global control |
| Conflicts | Conflict list | partial | `ChangesView.tsx` lists conflicted files only |
| Conflicts | Conflict resolver | planned | No code found |

### History and commits

| Area | Feature | Status | Evidence |
|---|---|---|---|
| History | Local branches and remotes only | done | `src/main/git/history.ts` (`readHistory`, `--branches --remotes`) |
| History | Checkpoint and backup refs excluded | done | `history.ts` (same log scope) |
| History | Commits reachable only from detached HEAD are omitted | not supported | `src/main/git/history.ts` uses `--branches` and `--remotes` without HEAD; detached commits reachable from a branch still appear |
| Graph | Lane layout ported from better-source-control | done (ported per code comment) | `src/main/git/graph.ts` (`layoutGraph`), `src/renderer/src/HistoryView.tsx` (comment, `graphSegments`) |
| Graph | Fixed 28 px rows | done | `HistoryView.tsx` (`ROW_HEIGHT = 28`) |
| Graph | Up and down arrows step through commits | done | `HistoryView.tsx` (`onKeyDown`, `step`) |
| Graph | Next page loads ahead of cursor | done | `HistoryView.tsx` (`step`, `next >= rows.length - 5`), `PAGE = 300` |
| Graph | Load more button | done | `HistoryView.tsx` (`.more`) |
| History | Commit message search | done | `history.ts` (`searchHistory`, `-i -F --grep`), `HistoryView.tsx` (search input), `Cmd+F` in `src/main/menu.ts` |
| History | Search beyond commit messages (author, path, diff) | planned | No code found |
| History | Commit details with parsed file stats | done | `HistoryView.tsx` renders `CommitStat` from `current.files`; `CommitStat.tsx` has file icons, scaled add/delete bars, coloured counts and binary notes; `history.ts` (`commitDetails`) returns only `{ body }`, no raw stat text |
| History | Commit icon action bar, state changes overflow first | done | `CommitMenu.tsx` puts state-changing actions last; `OverflowBar.tsx` retains a prefix and moves the tail into More actions, with group dividers |
| History | Compare mode with Exit comparison button | done | `HistoryView.tsx` (`compareWith`, `compare-bar`) labels selected/comparison refs and totals; Exit comparison clears it; `index.ts` resolves both refs; `src/main/git/diff.ts` uses fixed 3-line context |
| History | Ref labels truncate, capped to one ref plus +N | done | `HistoryView.tsx` (`CommitRow`) shows `refs[0]` and `+N`, plus a separate HEAD badge; `styles.css` caps `.ref` at 40% with ellipsis; refs use `flex: none` |
| History | Empty history and search-result copy | done | `HistoryView.tsx` renders "This repository has no commits yet." in detail, or "No commits to show." for an empty result list |
| History | Focusable commit list with plain list semantics | done | `HistoryView.tsx` uses a labelled focusable div, `ul`/`li`, arrow-key selection and `aria-current`; no `listbox`/`option` roles or `aria-activedescendant` |
| History | Pending labels and guards for commit actions | done | `CommitMenu.tsx` (`WORKING`, `shown`, `runGit`) changes labels and disables state changes while pending; `HistoryView.tsx` owns pending state |
| Commit card | Show diff | done | `CommitMenu.tsx` (`onOpenChanges`), `HistoryView.tsx` scrolls `diffRef` into view |
| Commit card | Open Changes on Remote | done | `CommitMenu.tsx` (`openRemote`), `remoteWebBase` |
| Commit card | Checkout detached | done | `CommitMenu.tsx`, `src/main/git/ops.ts` (`checkoutDetached`) |
| Commit card | Create branch from commit | done | `CommitMenu.tsx` (`PromptDialog`), `ops.ts` (`branchFromCommit`, `assertBranchName`) |
| Commit card | Create tag from commit | done | `ops.ts` (`tagFromCommit`, `check-ref-format`) |
| Commit card | Cherry-pick (backup ref first) | done | `ops.ts` (`cherryPick`, `createBackupRef`), `CommitMenu.tsx` |
| Commit card | Revert (confirm, backup ref first) | done | `ops.ts` (`revertCommit`), `CommitMenu.tsx` (`window.confirm`) |
| Commit card | Amend message, HEAD only, preserving staged changes | done | `ops.ts` (`amendMessage`, `commit --amend --only`), `CommitMenu.tsx` (`disabled: hash !== head`); ordinary `commit` amend helper does not use `--only` |
| Commit card | Amend target, rewrite warning, and pushed-commit warning | done | `CommitMenu.tsx` (`CommitDialogs`) names hash/subject and warns about a new hash; upstream merge-base check adds a force-push warning when the commit is reachable; failed checks omit that warning |
| Commit card | Compare with remote | done | `CommitMenu.tsx` (`compareRemote`), `src/main/index.ts` (`repo:compare`) |
| Commit card | Compare with merge base | done | `ops.ts` (`mergeBase`), `CommitMenu.tsx` (`compareBase`) |
| Commit card | Compare with ref | done | `CommitMenu.tsx` (`ref` prompt), `index.ts` (`resolveCommit`) |
| Commit card | Copy hash, message, remote link | done | `CommitMenu.tsx` (`copy`) |
| Commit card | Undo after cherry-pick or revert | planned | `ops.ts` returns backup refs; cherry-pick shows a notice, revert does not; no renderer caller of `restore` |

### Repository toolbar and menus

| Area | Feature | Status | Evidence |
|---|---|---|---|
| Toolbar | All repository actions as icons with overflow and group dividers | done | `App.tsx` (`RepoPane`, `OverflowBar`), `RepoMenu.tsx` (`repoItems`), `OverflowBar.tsx` (`countFit`, `ResizeObserver`, More actions menu), `overflow-bar.css` |
| Toolbar | Branch switch | done | `App.tsx` (`branch-pill` select), `ops.ts` (`switchBranch`) |
| Toolbar | Ahead and behind counts | done | `App.tsx` (`sync`), `src/main/git/status.ts` |
| Repo menu | Show Commit Graph | done | `src/renderer/src/RepoMenu.tsx` |
| Repo menu | Copy branch name | done | `RepoMenu.tsx` (`copyBranch`) |
| Repo menu | Pull and Merge (default) | done | `RepoMenu.tsx`, `ops.ts` (`pull`, `--no-rebase`) |
| Repo menu | Pull and Rebase | done | `RepoMenu.tsx`, `ops.ts` (`pull`, `--rebase`) |
| Repo menu | Pull from remote and branch | done | `StashDialog.tsx` (`PullFromDialog`), `ops.ts` (`pullFrom`, `assertRemote`, `assertBranchName`) |
| Repo menu | Push (sets upstream on first push) | done | `ops.ts` (`push`), `src/main/index.ts` (`repo:push`) |
| Repo menu | Reset branch to named upstream, danger styling | done | `RepoMenu.tsx` labels `Reset branch to <upstream>…`, sets `danger: true`, and confirms loss of edits; `OverflowBar.tsx` renders danger classes; `ops.ts` backs up HEAD then runs `reset --hard @{u}`, without worktree backup |
| Repo menu | Pending labels for repository actions | partial | `RepoMenu.tsx` (`WORKING`, `shown`) labels fetch/pull/push/reset/stash/pop and disables conflicting toolbar actions; `StashDialog.tsx` pull-from/apply/pop buttons lack pending labels |
| Repo menu | Reset undo banner | planned | `ops.ts` (`restoreBackup`) has IPC `repo:restore`, but no renderer caller |
| Repo menu | Stash changes (includes untracked) | done | `ops.ts` (`stashPush`), `RepoMenu.tsx` |
| Repo menu | View, apply, pop stash dialogs | done | `src/renderer/src/StashDialog.tsx` (`COPY`, `StashDialog`) |
| Repo menu | Pop latest stash | done | `RepoMenu.tsx` |
| Repo menu | Drop stash | backend only | `ops.ts` (`stashAction`), `index.ts` and preload expose drop; `StashDialog.tsx` offers only view/apply/pop |
| Repo menu | Fetch all repositories | done | `src/renderer/src/App.tsx` (`fetch-all`), `src/main/menu.ts` |
| Git helpers | Worktrees list and add | backend only | `ops.ts` (`readWorktrees`, `addWorktree`); `test/git.test.ts` covers listing only; no IPC or UI |
| Git helpers | Blame | backend only | `ops.ts` (`blame`); no IPC or UI |
| Git helpers | File history | backend only | `history.ts` (`fileHistory`), tested in `test/git.test.ts`; no IPC or UI |
| Git helpers | Switch to a new branch and delete branch | backend only | `ops.ts` (`createBranch`, `deleteBranch`); these helpers have no IPC/UI; creating a branch from a commit is separately wired |

### Background, watching, and config

| Area | Feature | Status | Evidence |
|---|---|---|---|
| Fetch | Background fetch every N minutes | done | `src/main/background.ts` (`BackgroundFetcher.start`), `src/main/index.ts` (`applyRuntime`) |
| Fetch | Runs when system idle is at or below the threshold | done | `background.ts` skips only when `powerMonitor.getSystemIdleTime()` exceeds `idleThresholdSeconds` |
| Fetch | Fetch only, never pull or push | done | `background.ts` (`fetchAll` only) |
| Fetch | Skip repos with no remote | done | `background.ts` (`hasRemote`) |
| Fetch | Settings: on/off, interval | done | `src/renderer/src/Dialogs.tsx` (Background fetch section), `src/main/config.ts` |
| Fetch | Idle threshold, default 120 seconds; Settings control pending | in progress | `src/main/config.ts` (`idleThresholdSeconds`), `background.ts` uses it; `Dialogs.tsx` has no threshold input |
| Fetch | Background-fetch status display | planned | `App.tsx` listens to `fetch:report` but only bumps a revision; no status UI |
| Fetch | Manual fetch IPC | done | `src/main/index.ts` (`fetch:now`) |
| Watch | Live file watching with 300 ms batching | done | `src/main/watch.ts` (`SourceWatcher`, `@parcel/watcher`) |
| Watch | Repo added or removed in tree triggers rescan | done | `watch.ts` (`tree` flag), `App.tsx` (`refreshTree`) |
| Config | JSON in userData folder | done | `src/main/index.ts` (`configFile`), `src/main/config.ts` |
| Config | Invalid JSON moved aside before defaults are loaded | done | `config.ts` (`loadConfig`, `.corrupt-` rename); valid JSON with missing fields is normalized |
| Config | Atomic save via temp file and rename | done | `config.ts` (`saveConfig`) |
| Config | Older configs fill defaults | done | `config.ts` (`normalizeConfig`) |
| Window | Persist normal bounds and maximized state; debounce 500 ms | done | `config.ts` (`AppConfig.window`, `WindowState`), `index.ts` (`saveWindowState`) handles move/resize/maximize/unmaximize |
| Window | Synchronous atomic save on close | done | `src/main/index.ts` (`flushWindowState`) clears the timer, writes config.json.tmp, and renames it synchronously |
| Window | Restore on-screen bounds; runtime minimum 900x560 | done | `index.ts` (`isOnScreen`, `createWindow`) accepts any display overlap; `config.ts` only rejects saved sizes below 480x320, which differs from the BrowserWindow minimum |
| Session | Restore repo, tab, panel visibility, and per-repo file/commit | done (code verified, not run) | `session.ts` uses `bettergit.session`; `App.tsx` loads/saves session; Changes uses `savedSelection`/`savePlace`; History loads/saves selected commit |
| Sidebar | Dirty counts include every untracked file and replay after reload | done | `dirty.ts` runs `status --porcelain=v1 --untracked-files=all`; `DirtyCounter.request` re-emits fresh cached counts; `index.ts` requests counts on `sources:tree`; `test/git.test.ts` covers both behaviors |
| Clone | Destination asked each time, defaults to last | done | `Dialogs.tsx` (`CloneDialog`, `Choose…`), `index.ts` (`lastCloneDirectory`) |
| Clone | Uses existing git and SSH credentials, no token storage | done | `src/main/git/exec.ts` (no credential code, `GIT_ASKPASS` empty), `Dialogs.tsx` (subtitle) |

### Appearance and UI

| Area | Feature | Status | Evidence |
|---|---|---|---|
| Theme | System, light, dark, follows macOS | done | `App.tsx` (`matchMedia`, `dataset.theme`), `src/main/index.ts` (`nativeTheme.themeSource`) |
| Theme | Theme setting in Settings and menu | done | `Dialogs.tsx` (`THEMES`), `src/main/menu.ts` (`Appearance`) |
| Theme | Light mode visuals | unverified | Light variables in `src/renderer/src/styles.css`; not seen rendered |
| Layout | Floating glass panels, 8 px window margin | done (code verified, not run) | `styles.css` (`.changes > .diff-pane`, margins), `.splitter.gap` |
| Layout | Draggable dividers, grid written during drag, commit on release | done | `src/renderer/src/Splitter.tsx` (`paint`, `commit`, `requestAnimationFrame`) |
| Layout | Divider arrow keys step 12 px, Shift steps 48 px; double-click resets | done | `Splitter.tsx` (`onKeyDown`, `onDoubleClick`, `commit`) |
| Layout | Sidebar, Changes-list, and History-list widths remembered | done | `Splitter.tsx` (`useResizable`); callers use `bettergit.sidebarWidth`, `bettergit.changesListWidth`, `bettergit.historyListWidth` in localStorage |
| Layout | Toggle sidebar | done | `menu.ts` (`Cmd+Shift+S`), `App.tsx` |
| Layout | Three independent tab-row panel toggles, persisted | done | `App.tsx` (`pane-toggles`) uses Sidebar, File list/Commit list, and Detail labels, constant across open/closed state; `Icons.tsx` sets `aria-pressed` and maps `paneList` to Columns3; `session.ts` persists visibility |
| Layout | Traffic-light clearance with sidebar closed | done | `App.tsx` adds `sidebar-closed`; `styles.css` adds 84 px toolbar left padding |
| Text | Page zoom: Small 0.9, Default 1, Large 1.15, Largest 1.3 | done | `Dialogs.tsx` (`TEXT_SIZES`), `src/main/index.ts` (`setZoomFactor`), `config.ts` clamps saved values to 0.8 through 1.6 |
| Visual | Shared surface blur token | partial | `styles.css` uses `--glass-blur: 30px` for surfaces; `.scrim` still has hardcoded `blur(8px)`, so blur is not fully consolidated |
| Visual | Solid fills replace decorative background gradients | partial | `styles.css` retains functional tree-guide and split hatch gradients, plus flat mask gradients on panel rims; `file-icons.ts` retains upstream SVG gradients; gradient removal is not absolute |
| Visual | One solid accent fill per theme | done | `styles.css` defines `--accent-fill` as #0067d0 light and #0a6ad0 dark; `--accent` remains #0067d0 light and #0a84ff dark |
| Visual | GUI icons use Lucide behind stable IconName keys | done | `src/renderer/src/Icons.tsx` imports `lucide-react`, maps `ICONS`, and exports `IconName`; hand-drawn GUI path table is absent |
| Visual | Semantic colour and neutral raised shadows, no decorative glows | done | `styles.css` uses semantic status/selection colours and neutral shadows; `HistoryView.tsx` uses lane colours; upstream file-icon colours remain |
| Visual | Shared radius and shadow tokens | done | `styles.css` defines card 8, chip 6, pill 999, sm 7, default 10, lg 16 and panel 12 px tokens, `--shadow-raised` and theme-specific `--glass-edge`; some literal radii remain; visual consistency unverified |
| Tooltips | Shared portal tooltip implementation for icon buttons | partial | `Icons.tsx` (`Tooltip`, `IconButton`) portals to body, clamps horizontal position and flips above near bottom; not a singleton, no explicit top clamp or oversized-label handling; Add/More buttons use native `title` tooltips |
| Dialogs | Focus trap, inert root, and focus return | done | `Dialogs.tsx` (`useDialogFocus`) focuses first control, wraps Tab/Shift+Tab, sets root inert and restores opener; Modal, `PromptDialog.tsx`, and `StashDialog.tsx` Sheet use it |
| Dialogs | Protect prompt drafts on Escape and scrim dismissal | done | `PromptDialog.tsx` and `Dialogs.tsx` CloneDialog request confirmation before discarding changed text; Settings commits language edits on close; PullFromDialog does not guard its draft |
| Fonts | SF Pro via system stack, not bundled | done | `styles.css` (`--font-ui`) |
| Fonts | JetBrains Mono bundled via @fontsource | done | `src/renderer/src/main.tsx`, `package.json` |
| Motion | CSS animations and transitions, no Motion library | done | `styles.css` (`@keyframes`, transitions); `package.json` has no Motion dependency; transitions also include colour, width, and shadows |
| Motion | Reduced motion respected | done | `styles.css` (`prefers-reduced-motion`) |
| Performance | 240 Hz smooth interaction | unverified | Measures in place (`content-visibility` on `.diff-file`, no React work during drags). Not measured |
| Empty state | Add folder or clone prompts | done | `App.tsx` (`Empty`) |
| Errors | Dismissable error banner | done | `App.tsx` (`banner`) |

### Platform, build, and tests

| Area | Feature | Status | Evidence |
|---|---|---|---|
| Platform | Mac-only window (hidden inset title bar, vibrancy) | done | `src/main/index.ts` (`titleBarStyle`, `vibrancy`) |
| Build | electron-vite dev and build scripts | done | `package.json` (`dev`, `build`, `start`), `electron.vite.config.ts` |
| Build | Bun for tests and sample generation | done | `package.json` (`test: bun test`, `sample`) |
| Build | Typecheck script | done | `package.json` (`typecheck: tsc --noEmit -p tsconfig.json`); `bun run typecheck` passes during this refresh |
| Build | Packaging with electron-builder | planned | Not in `package.json` |
| Build | Code signing | planned | Private, unsigned local build |
| Tests | Unit tests for git ops, history, diffs, graph, scan, dirty counts | done | `bun test` passes 20 tests across `test/git.test.ts`, `test/graph.test.ts`, `test/scan.test.ts`, with 45 assertions and 0 failures during this refresh |
| Tests | Tests for config, watcher, background fetch, moves UI | planned | No test files found |
| Sample | Sample workspace generator | done | `scripts/create-sample-workspace.ts`, `fixtures/` (gitignored) |
| Dev loop | watch-build rebuilds main/preload/renderer; watch-app restarts only on main/preload hash changes | in progress | No `watch-build`, `watch-app`, output hashing, or watcher scripts found in `package.json`, `scripts/`, or `electron.vite.config.ts`; only standard electron-vite scripts exist |
| Dev loop | Avoid app.relaunch on rebuild to prevent duplicate instances | done (code verified, not run) | No `app.relaunch` in `src/` or `scripts/`; desired restart/hash workflow is not implemented here |
| Dev loop | Single-instance lock | planned | No `requestSingleInstanceLock` found |

### Security

| Area | Feature | Status | Evidence |
|---|---|---|---|
| Electron | contextIsolation and sandbox on, no node integration | done | `src/main/index.ts` (`webPreferences`) |
| Electron | Named API on window.bettergit; no raw ipcRenderer or Node API | done | `src/preload/index.ts` (`contextBridge.exposeInMainWorld`); named invocations and event subscriptions |
| CSP | default-src self; data images/fonts allowed; WASM eval forbidden | done | `src/renderer/index.html` sets `default-src 'self'`, inline styles, `font-src 'self' data:`, and `img-src 'self' data:`; no wasm-unsafe-eval |
| Paths | Repo paths checked against configured source prefixes | done | `src/main/index.ts` (`assertKnownRepo`) resolves paths and requires source equality or a descendant path; it does not resolve symlinks or verify repo identity |
| Git | Argument arrays, no shell strings | done | `src/main/git/exec.ts` (`spawn`) passes git config flags and args as one array |
| Git | Action and comparison refs resolved with rev-parse | partial | `ops.ts` (`resolveCommit`) validates commit actions/comparisons; `index.ts` (`repo:commit`) passes the renderer hash directly to commitDiff/commitDetails |
| Git | Branch-from-commit, pull-from branch, and tag names validated | partial | `ops.ts` (`assertBranchName`, `tagFromCommit`); `switchBranch`, `createBranch`, and `deleteBranch` do not validate names |
| Git | No credential prompts (`GIT_TERMINAL_PROMPT=0`) | done | `exec.ts` |
| Links | `openExternal` accepts https only | done | `src/main/index.ts` (`system:open-url`) |

## Key decisions

- Keep Electron and a Mac-only scope for native vibrancy and the hidden inset title bar, as configured in `src/main/index.ts`.
- Aim for a current VS Code / better-source-control feel with floating frosted-glass panels and no 2000s-era styling. This is the supplied design direction; code confirms panel blur and BSC graph/action grouping, not visual fidelity.
- Use one solid blue accent fill per theme and colour for status, syntax, selection, and graph meaning. `styles.css` removes decorative glows and shares raised-shadow and glass-edge tokens.
- Replace decorative background gradients with solid fills. Functional guide/hatch gradients, flat panel masks, and some upstream SVG gradients remain, so the no-gradient direction is only partly complete.
- Use plain CSS and existing React controls to keep styling under project control, as shown by `styles.css` and `package.json`.
- Combine Electron vibrancy with CSS backdrop blur for the desktop and panel backgrounds. No SVG refraction filter is implemented.
- Write splitter gridTemplateColumns directly on the parent through requestAnimationFrame during drag, then commit React state and localStorage on pointerup to avoid per-move React renders. `Splitter.tsx` also supports reset and keyboard steps.
- Use Shiki 4.5.0 with the JavaScript regex engine because the CSP forbids WASM evaluation. `highlight.ts`, `DiffView.tsx`, and `styles.css` pass theme colours through `--tok-light` and `--tok-dark`.
- Embed MIT-licensed vscode-icons as data URIs for familiar file types without external image requests. `file-icons.ts` retains the license; `FolderIcon` now serves sidebar folder/repo rows.
- Route GUI icons through Lucide `IconName` keys so call sites name actions and share one icon set. `Icons.tsx` replaces the hand-drawn GUI path table.
- Show +/- totals on files and file counts on folders to avoid mixing line totals with navigation counts. `ChangesView.tsx` now renders lock-file counts too; `paths.ts` still has an unused `isLockFile` helper.
- Start lock files and diffs over 400 changed lines collapsed so they do not bury other diffs. `DiffView.tsx` lets users expand them.
- Widen context per file using + rows around each hunk so other files keep their loaded context. `ChangesView.tsx` uses 3/10/25/All steps; History retains the shared global control.
- Detect moved blocks by trimmed contiguous lines, minimum 3, to recognize reindentation without parsing git colour output. `git/diff.ts` implements a heuristic, not git's move algorithm.
- Connect moved blocks only in split view with plain cubic lines, without arrowheads. Move notes have their own rows in both layouts; `DiffView.tsx` no longer inserts labels into code cells. Alignment remains unverified visually.
- Limit history and search to branches/remotes to exclude backup/checkpoint histories. `git/history.ts` consequently omits commits reachable only from detached HEAD or tags.
- Use 28 px graph rows and BSC-style lane geometry so history stays compact. `HistoryView.tsx` and `git/graph.ts` identify the port; upstream parity is unverified.
- Share `OverflowBar` between repo and commit actions so narrow layouts can move icons into a More actions menu with group dividers.
- Read sidebar HEAD labels from disk to avoid a git process per label. `git/head.ts` handles .git files; `DirtyCounter` limits background status subprocesses to 4, counts all untracked files, and replays cached counts for a reloaded renderer.
- Save window bounds after a 500 ms debounce, then flush synchronously and atomically on close so quitting does not rely on an unfinished async write. `isOnScreen` rejects wholly off-screen saved positions.
- Keep selected repo, tab, sidebar/list/detail visibility, and per-repo file/staged/commit selection in localStorage at `bettergit.session`. `App.tsx`, Changes, and History load/save it. Commit drafts use a separate in-memory Map and survive switching, not reloads. Code verified, not run.
- Scale text with page zoom so rows, gutters, and dividers scale together. Settings offers Small 0.9, Default 1, Large 1.15, and Largest 1.3.
- Fetch in the background only while idle time is at or below the configured threshold so unattended work is limited. `background.ts` never pulls or pushes; the default threshold is 120 seconds.
- Use git CLI argument arrays to reuse machine credentials without storing tokens and avoid shell interpolation. `git/exec.ts` disables terminal credential prompts by default.
- Default pull to merge using `--no-rebase`, not an explicit fast-forward-only flag. `ops.ts` still permits rebase as an explicit action and does not override all user git configuration.
- Back up HEAD before reset, cherry-pick, and revert to retain commits. Reset uses `--hard` and discards uncommitted edits without backing them up; the renderer confirms this distinction.
- Confirm reset, revert, and discard in the renderer to reduce accidental changes. Cherry-pick currently has no confirmation; revert does not show its backup ref.
- Restore backups with `reset --keep` to refuse overwriting local edits. `ops.ts` and IPC expose the helper, but no undo UI calls it.
- Amend only HEAD's message with `commit --amend --only` so staged changes stay staged. This applies to `amendMessage`, not the ordinary commit helper's amend option.
- Keep sidebar removal config-only and move invalid JSON config aside so removing a source or recovering settings preserves files.
- Validate repo paths against configured sources in the main process, expose named preload functions with isolation/sandbox enabled, and accept only HTTPS in `system:open-url` to limit renderer privileges.
- Use system SF Pro and bundle JetBrains Mono through @fontsource, matching `main.tsx` and the CSS font stacks without redistributing SF Pro.
- Use CSS animations and reduced-motion rules to avoid an animation dependency. Current transitions include colour, width, and shadows as well as transform/opacity.
- Rebuild main, preload, and renderer in watch-build, but restart only when main/preload output hashes change so renderer edits reload in place. This requested workflow is in progress; no matching scripts exist and no app.relaunch call is present.
- Keep repeatable sample repos in gitignored fixtures for development. `scripts/create-sample-workspace.ts` supplies the generator; it was not run for this refresh.

## Review and fix pass (2026-10-16)

Counts are supplied review totals. States summarize current source coverage, not a finding-by-finding closure audit. Code verified, not run.

| Review | Findings | State | Verification |
|---|---|---|---|
| Opus design review | 1 blocker, 15 major, 24 minor | partly fixed | Source fixes cover icons, session/panels, diffs, stats and dialogs; remaining gaps are recorded below; full review closure unverified |
| Sol design review | 13 major, 16 minor | partly fixed | Source fixes cover action order, warnings, pending labels, keyboard access and styling; full review closure unverified |

## Constraints and non-goals

- Mac only. The window uses macOS-only options.
- Private, unsigned local build. No distribution pipeline.
- Git must be installed. The app adds `/usr/bin`, `/usr/local/bin`, and `/opt/homebrew/bin` to PATH.
- No token storage and no account picker. Credentials come from the machine.
- Background fetch never pulls or pushes.
- Not a full Git client: no interactive rebase, no conflict resolver, no blame UI, no worktree UI.
- No AI features.
- Renderer-only in-place reload and hash-gated main/preload restart are the intended custom dev loop, still in progress in this checkout.
- Text size range is 0.8 to 1.6 in config. Settings offers 0.9 to 1.3.

## Known risks

| Item | Detail | Status |
|---|---|---|
| Undo after reset, cherry-pick, revert | Reset and cherry-pick show backup ref notes; revert does not. No undo action. `restoreBackup` exists with no UI. | open |
| Revert backup ref not shown | `revertCommit` returns a backup ref, but `CommitMenu.tsx` does not display it. | open |
| Cherry-pick has no confirm | Other destructive actions confirm. Cherry-pick calls the operation immediately, without confirmation. | open |
| Clone parent path not validated | `clone` IPC does not check `parent` against sources or a safe path. The URL goes to `git clone` after `--`. | risk |
| Switch branch name not validated | `switchBranch` passes the name to `git switch` without a check-ref-format. A name starting with `-` could act as an option. | risk |
| Stash ref not validated | `stash-action` takes a ref from the renderer and passes it to git. | risk |
| Push hardcodes `origin` on first push | `ops.push` uses `origin` when no upstream is set. Other remotes are not supported for first push. | risk |
| Detached/tag-only commits hidden in history | `--branches --remotes` omits commits reachable only from detached HEAD or tags, as well as backup-only histories. | risk |
| Background fetch status | Fetch reports are received but not shown. Failures are silent to the user. | open |
| Idle threshold has no UI | `idleThresholdSeconds` works in background fetch but has no Settings input. | in progress |
| Single-instance lock missing | Two app instances can run on the same config. | open |
| Corner-radius scale unaudited | Tokens cover panel 12, card 8, chip 6, sm/default/lg 7/10/16, pill 999 px; dialogs now use lg. Literal radii remain; consistency and window corners have not been visually checked. | unverified |
| Light mode | Variables exist. Not seen rendered. | unverified |
| 240 Hz target | Aspiration. Not measured. | unverified |
| Stale CSS comments | Comments mention refraction and liquid glass. Filter is gone. | cleanup |
| Unused aurora variables | `--aurora-*` defined, not used. | cleanup |
| Unused grouping config | `groups` is normalized and persisted but has no UI/IPC dedicated to grouping. `idleThresholdSeconds` is used by the fetcher. | cleanup |
| Reset loses uncommitted edits | `resetToUpstream` uses `reset --hard`. The backup ref saves HEAD commits, not worktree/index edits; the UI warns before proceeding. | risk |
| Remote link URLs with ports | `CommitMenu.tsx` (`remoteWebBase`) splits host at a colon; `https://host:8443/owner/repo.git` becomes `https://host/8443/owner/repo`. Commit links can target the wrong URL. | risk |
| Move-note and connector geometry | Notes occupy separate rows, connectors have no arrowheads, and long code wraps. Clearance and alignment have not been checked in Electron. | unverified |
| Styling consolidation incomplete | Functional guide/hatch and flat mask gradients remain, as do upstream SVG gradients. Surface blur is tokenized, but the scrim still hardcodes 8 px. | partial |
| Tooltip coverage and window edges | Shared icon-button portal clamps horizontally and flips vertically, but has no top clamp or oversized-label policy. Add/More buttons use native `title` tooltips instead of the portal. | partial |
| History list accessibility | Focusable wrapper and plain list items use `aria-current`. No listbox/option semantics or active-descendant wiring exists. | partial |
| Dialog draft protection scope | Prompt/Clone confirm changed text; Settings saves language edits on close. Pull-from drafts still close without a discard guard. | partial |
| Dirty invalidation under folder sources | Ordinary worktree events map to the configured source path, not the nested repo path, in `watch.ts`. Nested repo pills can remain stale until a repo-specific .git event or app restart; a tree request alone reuses cached counts. | risk |
| Window minimum mismatch | `normalizeWindow` accepts 480x320, but `BrowserWindow` enforces 900x560. The config comment says these match; they do not. | risk |
| Comparison context control | Comparison requests use fixed `-U3`; changing the shared History context preference reloads commit detail, not the active comparison. | risk |
| Path check is lexical | `assertKnownRepo` checks configured source prefixes without realpath or repository validation. Descendant symlinks can point outside a source; config:update also accepts renderer patches without normalization. | risk |
| Commit message duplication | `commitDetails` returns the full message via `%B`; `CommitMenu.tsx` combines subject and that body again for copy/amend, which can duplicate the subject. | risk |
| No packaging | No packaging/signing pipeline is configured; distribution needs a packaging and signing decision. | open |
| Test gaps | No tests for config, watcher, background fetch, or UI. | open |
| Commit graph port | Code comment says ported from better-source-control. Upstream not compared. | unverified |

## Verification status

### Checked in the running app

- Nothing. The app was not run, per instructions.

### Read in code

- The starting 157-row feature table, core modules throughout `src/main/`, `src/preload/`, and `src/renderer/src/`, CSS, session helpers, icon metadata/mapping, parsed commit stats, dialogs and overflow bars.
- Feature evidence paths and symbols searched with `rg`; IPC helpers traced through preload and renderer callers where present.
- `package.json`, `bun.lock`, `electron.vite.config.ts`, `tsconfig.json`, `.gitignore`, the sample generator, and existing test definitions.
- Final source recheck covers every feature row and its evidence, including concurrent changes to session wiring, toggles, Settings, folder icons, move notes/connectors, stats, drafts, menus, dirty counts and styling. All app behavior is code verified, not run.
- Key decisions distinguish supplied design intent from implemented code. No external design history, licensing opinion, or upstream graph parity was independently established.

### Checked by command

| Command | Result |
|---|---|
| `rg` symbol/path and caller searches | Verified existing rows and recent-work claims against the current checkout; missing integrations are marked in progress, planned, or backend only |
| Documentation structure and evidence-path checks | Confirmed four-column feature rows and existing evidence files; final row count reported with this update |
| `bun test` | Pass, 20 tests across 3 files, 45 assertions, 0 failures |
| `bun run typecheck` | Pass, TypeScript reports no errors |

### Not checked

- This documentation worker did not run the app or screenshot harness, edit source/tests/config, or make a commit. Other workers changed renderer files during the review; their current code was rechecked before updating statuses.
- Any UI behavior, layout, move-note clearance, connector geometry, overflow fit, or visual result in Electron. Every app feature is code verified, not run.
- Light mode, the corner-radius scale, and fidelity to the supplied VS Code / better-source-control design direction.
- Performance, including the 240 Hz target and the 1,000-repo sidebar.
- Window/session restore behavior, panel toggle interactions, watcher invalidation, or background-fetch timing at runtime.
- Clone, push, pull, reset, cherry-pick, and revert against real remotes.
- Custom watch-build/watch-app behavior; matching scripts were not found in this checkout.
- Code signing and packaging. No pipeline is configured here.

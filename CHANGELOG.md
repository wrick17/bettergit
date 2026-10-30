# Changelog

Each release publishes its section below as the GitHub Release notes. Add the section before you push the `v<version>` tag.

## [0.1.12] - 2026-10-30

### Improved

- Fetch repositories in a folder concurrently while serializing fetches for linked worktrees that share refs.
- Show Stage and Unstage controls for diff hunks, with an action to show whitespace.
- Use the BetterGit app icon in development builds.

### Fixed

- Clear stale default fetch errors and identify the remote that failed.
- Align and color deleted lines correctly, and update Find highlighting when diff colors change.

## [0.1.11] - 2026-10-30

### Changed

- Confirm destructive file actions inline with two clicks. The first click turns the button red and shows "Click again to confirm"; the second runs it. This covers file and hunk discard, untracked-file deletion, draft discard, conflict reset, and Use Ours or Use Theirs.
- Staging a file with unsaved editor changes also asks for a second click. Ordinary staging remains one click.
- Moving away, losing focus, or pressing Escape cancels an armed action.

### Fixed

- Keep unchanged lines plain when small edits are spread across a large file. Both the diff preview and inline editor now preserve matching whole lines before comparing changed text, preventing a large false replacement block.

## [0.1.10] - 2026-10-29

### New

- See the effective commit author and edit Git identity for the current repository or globally.

### Improved

- Background fetches back off after transient failures and avoid duplicate requests for the same repository.

### Fixed

- Load extension marketplace details and downloads through the system network connection.
- Show fully staged files only in Staged and unstaged files only in Changes; partially staged files appear in both.
- Keep the visible diff position when staging or unstaging files.

## [0.1.9] - 2026-10-28

### New

- Resolve a conflicted file with one whole side using Use Ours or Use Theirs in its conflict bar. BetterGit asks first, then replaces the file with that side's version from Git. The file stays unmerged until you stage it.
- Choose Help > Show Command Log to see each Git command and action BetterGit runs, with its exit code, timing and failure status. The log updates while commands run. It records output sizes and hides messages and credentials. Error details remain in BetterGit's notifications.

### Fixed

- Show a Stage button on a conflicted file once no conflict markers remain, so you can mark it resolved from the conflict view.

## [0.1.8] - 2026-10-28

### New

- Refresh all repositories from the button in the repository list heading. The refresh updates the sidebar and the open repository without changing your selection.
- Fetch, Pull, and Refresh an individual repository from its sidebar actions menu or right-click menu.
- BetterGit checks for updates when it opens and once a day. Choose BetterGit > Check for Updates… to check now. Click Update to download, then Restart to Update when you are ready; BetterGit replaces itself where it is installed. It does not restart while a Git action runs or while you have unsaved edits.

### Improved

- Repository and folder menu items have icons. Git errors explain what happened and suggest next steps, with the original details and a retry action where available.

### Fixed

- Hide the toolbar's push and pull arrows when their counts are zero.

## [0.1.7] - 2026-10-28

### Fixed

- Restore fetch, fetch with tags, and fetch with prune, along with pull using merge, fast-forward only, rebase, and rebase with autostash.

### Changed

- Remove the standalone Pull and Merge toolbar button. Pull remains available in the Fetch dropdown and through the Actions shortcut.

## [0.1.6] - 2026-10-28

### New

- Failed actions now collect in a notification list. A bell in the bottom-right corner shows how many are unread. Each entry says what failed, in which repository and why. **Go to repository** opens that repository, and **Mark as read** or **Mark all as read** clears entries. Unread entries are kept after you restart BetterGit.
- A short message announces each new failure without taking focus, including while a dialog is open.
- Failures inside dialogs, such as cloning, choosing apps, installing extensions and branch actions, still show in the dialog and also go to the notification list, so they stay after the dialog closes.

### Improved

- A folder's **Refresh**, **Fetch All** and **Pull All** show their progress. The folder's **⋯** button spins while the action runs. The bottom of the sidebar shows how many repositories are done and which one is running, then a summary of how many succeeded, were skipped or failed. **Fetch All Repositories** in the app menu shows the same status.
- When **Fetch All** or **Pull All** fails in several repositories, each repository gets its own notification.
- Error messages no longer start with "Error invoking remote method".

### Fixed

- A second Refresh, Fetch All or Pull All can no longer start while one is running.
- Background fetch failures, a failed refresh from the app menu, choosing a clone folder, copying from menus, failing to list installed apps or extensions, an installed extension that cannot be read, a chosen theme that does not load, and changing the appearance from the app menu now report the error. Before, they failed silently.

## [0.1.5] - 2026-10-28

### New

- Each repository in the sidebar shows commits to push (↑) and to pull (↓), so a repository you have not opened shows what a fetch brought.
- Folders in the sidebar have **Refresh**, **Fetch All** and **Pull All**. Right-click a folder or click its **⋯** button. Pull All asks first and only fast-forwards. A repository that has diverged, has no upstream, or would overwrite local files is left unchanged and named in the error.

### Changed

- The toolbar's Fetch dropdown now lists two choices: **fetch** and **pull**.

### Fixed

- Background fetch runs every 10 minutes again. Collapsing folders, hiding repositories or other sidebar changes no longer restart its timer.
- A repository moved into or out of a sidebar folder appears or disappears without restarting BetterGit.

## [0.1.4] - 2026-10-27

### Improved

- The toolbar shows commits to push and to pull with ↑ and ↓ arrows next to the branch name.

### Fixed

- A fetch or pull that gets no response for two minutes now stops with an error, instead of showing **Fetching…** forever and blocking other Git actions.
- The toolbar no longer loses the ↑ and ↓ counts, or shows an older status, when an earlier refresh finishes after a newer one.
- Staging or unstaging a file no longer redraws its diff in Changes. The file keeps its rows, and the files below it stay in place.

## [0.1.3] - 2026-10-27

### New

- The branch picker shows tracking status. Local branches show commits to push (↑) and to pull (↓), and **gone** when their upstream branch was deleted. Remote branches that a local branch tracks show **Local**. The current branch shows its count of unresolved conflicts.
- Branch actions in the picker. Right-click a branch, click its **⋯** button, or press Shift+F10 to check it out, create a branch from it, rename or delete it, or set or unset its upstream. Delete refuses a branch that is checked out here or in another worktree.
- Hide branches from History and the branch picker with **Hide** or **Hide All Branches Except**. History shows how many branches are hidden, and **Show all branches** brings them back.
- Delete an untracked file from Changes. BetterGit first checks that the file is still untracked and inside the repository.

### Improved

- Changes and History highlight the file whose diff is on screen as you scroll.
- The file list and the diff pane show files in the same order in flat and tree views, including staged-only files.
- The commit stats summary takes less room.
- The window has an opaque native background, which makes Spaces swipes smoother.

## [0.1.2] - 2026-10-26

### Fixed

- Fetch/Pull and Push menu icons line up with the option title when its description wraps onto more lines.

## [0.1.1] - 2026-10-26

### Improved

- **Actions** opens on hover, like the Fetch/Pull and Push menus.
- Editor and terminal app icons in the toolbar are the same size.

### Fixed

- Hovering a toolbar menu no longer takes focus from the field you are typing in.
- Moving the pointer from one folded panel to another closes the first panel's preview at once.

## [0.1.0] - 2026-10-23

### Fixed

- The built-in light and dark themes have an opaque window background again. Since 0.0.8 the window showed other apps through it.

## [0.0.8] - 2026-10-23

### New

- Changes has 3, 10, 25 and All lines of context. Changing it keeps open editors, unsaved text, selection, undo and scroll.
- Settings combines theme choices and extension management in one **Themes** section. Extensions show their logo, Open VSX downloads and rating.
- **Details** opens an extension's README in the app, with images, badges and highlighted code blocks. It never downloads the extension.

### Improved

- Spaces swipes are smoother on external displays. BetterGit no longer uses native window vibrancy.
- History graph lanes are slightly wider, so crowded graphs are easier to follow.
- Light diffs use clearer green (`#C6F5C5`) and red (`#F7C7C8`) row fills, also under custom themes. Changed-word highlights run unbroken across syntax colors.
- Diff file headers span the pane, use the Files pane background and sit 8px apart.
- Long branch names in the sidebar expand on hover or keyboard focus.
- Refresh, Reload UI and Reveal in Finder have separate shortcuts.
- Open VSX search retries once after a brief network failure.

### Fixed

- Stage and Discard hunk actions are back on files you saved from the diff editor.
- A saved **All** context setting from an older version resets to 3 lines.

## [0.0.7] - 2026-10-22

### Improved

- Folded panels leave a thin rail at the window edge that expands when you hover or focus it.
- History shows the commit's files in the middle pane and its details above the diff on the right.
- Split diffs switch to unified when the pane is narrower than 900px and switch back when it widens.
- Authors with a GitHub noreply address show their GitHub picture. Other authors still use Gravatar.

## [0.0.6] - 2026-10-22

### New

- **Collapse all** and **Expand all** for the diff pane.
- Author pictures from Gravatar, with initials as the fallback.
- Commit details show the full hash, author and committer, date, parents, signature status, branches and tags that point at the commit, stats and the full message.

### Improved

- Fully added or deleted lines stand out more in unified and split diffs, including in the editor.
- A file with both staged and unstaged changes appears once in Changes and once in Staged. Stage all changes stages only unstaged files.
- Conflicted files are listed before Changes and Staged.

## [0.0.5] - 2026-10-20

### New

- Fetch/Pull and Push menus open on hover, click or keyboard, with every mode. Force push asks for confirmation.
- Stage, unstage or discard a single hunk. Each file has compact **+** and **−** buttons.
- Reorder repositories in the sidebar by dragging or with Alt+Arrow. The order is saved.
- Hide code diffs while keeping the changed-file list and comparison controls.

### Improved

- History follows the checked-out branch's HEAD and keeps search visible while you scroll.
- Graph lanes narrow toward the right, so wide graphs take less room.

## [0.0.4] - 2026-10-20

### Fixed

- Files in the commit tree sit right after the tree connector, without the extra gap.

## [0.0.3] - 2026-10-19

### Changed

- Settings no longer previews themes and icon themes before you install them. Search, install, replace, remove and theme selection still work.

### Fixed

- The commit tree in History uses the same file and folder spacing as Changes.

## [0.0.2] - 2026-10-19

### New

- The checkout picker groups branches, remotes, tags, stashes and worktrees into sections you can collapse and filter. Tags check out detached, stashes apply without being dropped, and worktrees open in the sidebar.
- VS Code color themes and file icon themes from Open VSX or a local `.vsix` file, with separate light and dark choices. BetterGit never runs extension code.
- Commit details have a list view and a folder tree view. BetterGit remembers your choice.
- New app icon.

### Improved

- History draws a marker for every commit, even past ten lanes. Merges are hollow, branch tips are larger and HEAD has a ring.
- App icons in the toolbar retry after a failed load.

### Fixed

- Pull, merge, rebase and tag checkout refuse to overwrite ignored or untracked local files.

## [0.0.1] - 2026-10-19

First release.

- One sidebar for every repository. Add a folder and BetterGit finds the repositories in it, with each one's branch and count of uncommitted files.
- Background fetch every few minutes while you are active. It never pulls or pushes.
- A stacked diff of every changed file in one scrolling pane, with staging, discard and commit.
- Edit working-tree files in the diff. Click an unstaged file's diff to edit it, ⌘S saves, Esc discards.
- Unified or split diffs, context lines, word wrap, hide whitespace, moved-code detection and syntax highlighting. Markdown diffs can render formatted.
- ⌘F finds text across the diff, including collapsed files and folded lines.
- History graph of all branches, with message search, an author filter and a commit menu to check out, branch, tag, cherry-pick, revert, amend and compare.
- Branch switcher for local and remote branches.
- Conflict resolver with accept current, incoming or both for each conflict, inline or side by side. It saves the file without staging it.
- Fetch, pull, push, stash and reset to upstream. Reset, cherry-pick and revert save a backup ref first.
- Open files in VS Code.
- Light and dark themes, resizable panes that fold away, and Reduce Motion support.

---
title: '`git stash` is not usable in this repo — the working tree belongs to every agent at once'
severity: 'major'
---

To measure a before/after I reached for the obvious tool: `git stash push -- src/`,
run the baseline, `git stash pop`. In a single-author repo that is a two-command
idiom. Here it stashed a peer agent's in-progress work as well as mine — the push
reverted `src/sim/GameState.ts`, `src/sim/Rules.ts` and `src/sim/Game.ts` to HEAD
under a peer who was actively editing them — and the pop then refused:

    error: Your local changes to the following files would be overwritten by merge:
        src/sim/Game.ts
        src/sim/GameState.ts
        src/sim/Rules.ts

`git stash` has no path-scoped notion of "mine". The brief's file-ownership rules
are about which files you may *edit*; a stash ignores them, because it operates on
the whole index and worktree. The ownership convention has a hole in it exactly the
size of every whole-tree git command: `stash`, `checkout .`, `restore .`,
`clean -fd`, `reset --hard`.

This one ended without data loss, and only by luck: the peer's files happened to be
byte-identical to what had been stashed, so `git checkout stash@{0} -- <my two
files>` followed by `git stash drop` put everything back. Had they saved a single
character in the twenty seconds their work was reverted on disk, the newer version
would have been the one that survived and their earlier edit would have been in the
stash nobody would think to look in.

**What to do instead.** A detached worktree is the same idiom without the blast
radius, and it is what the briefs already ask for when verifying a commit is
self-contained:

    git worktree add --detach <scratch>/wt-base HEAD
    ln -s "$PWD/node_modules" <scratch>/wt-base/node_modules
    # baseline runs here; copy your own changed files in for the "after" run
    git worktree remove <scratch>/wt-base

It is strictly better than the stash even in a single-agent repo: baseline and
change can run against the same seeds minutes apart without touching the tree the
editor has open, and the peer's half-finished edits are not silently part of your
"before" number either.

Worth adding to AGENTS.md as a hard rule: **no whole-tree git command in the shared
checkout.** Stage by explicit path, and take a worktree when you need a clean one.

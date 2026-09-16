// A relocation script is one of two kinds of file in this repo that can destroy data (the other is
// the restore drill). These pin the properties that keep it survivable, not its phrasing.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const path = resolve(process.cwd(), 'deploy/relocate-fedbench-data.sh')
const raw = readFileSync(path, 'utf8')

/** Shell with whole-line comments removed: a rule a comment can satisfy is not a rule. */
const directives = raw
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')

describe('deploy/relocate-fedbench-data.sh', () => {
  it('never deletes the original data', () => {
    // The single most important property. The source is the only copy that has not been through
    // this script; it is renamed and left for a human to remove after a restic run and a restore
    // drill have both passed.
    expect(directives, 'the original must be renamed, not removed').toMatch(/mv "\$target" "\$\{target\}\.pre-relocate"/)
    const destructive = directives
      .split('\n')
      .filter((l) => /\brm\s+-[rf]|rm\s+-rf|\bshred\b/.test(l))
      .filter((l) => !/rsync/.test(l))
    expect(destructive, 'no line may delete a tree; --delete-after on rsync targets the destination only').toEqual([])
  })

  it('verifies the copy instead of trusting the exit status', () => {
    // rsync can exit non-zero paths that still leave a partial tree, and a copy that is short is
    // the failure that matters. Proven locally against both shapes: a missing file changes the
    // entry count, a truncated file changes only the byte total, and the check catches each.
    expect(directives, 'entries must be counted on both sides').toMatch(/find "\$src" -xdev \| wc -l/)
    // REGULAR-FILE bytes, not `du -sb`. du sums directory st_size too, and on XFS a directory's
    // size depends on its insertion history: the first run on edaserver (2026-09-16) had 26,839
    // entries on both sides and a destination 884,456 bytes LARGER, all of it directory inodes.
    // A byte check that a correct copy cannot pass is not a check.
    expect(directives, 'bytes must be summed over regular files on the source').toMatch(
      /find "\$src" -xdev -type f -printf '%s\\n'/,
    )
    expect(directives, 'bytes must be summed over regular files on the destination').toMatch(
      /find "\$dst" -xdev -type f -printf '%s\\n'/,
    )
    expect(directives, 'du -sb must not be used as the byte comparison').not.toMatch(/du -sb/)
    // Counts and sizes cannot see a same-size content change; a checksum dry run can, and its
    // empty output is the proof. Verified in a container: an identical copy itemizes nothing, a
    // one-byte flip in a same-size file is reported as `>fc........ path`.
    expect(directives, 'content must be compared with an rsync checksum dry run').toMatch(
      /rsync -aHAX --numeric-ids --checksum --dry-run --itemize-changes "\$src"\/ "\$dst"\//,
    )
    expect(directives, 'a mismatch must be a failure, not a warning').toMatch(
      /VERIFICATION FAILED[\s\S]{0,200}?return 1/,
    )
    expect(directives, 'a checksum difference must be a failure that stops the move').toMatch(
      /checksum pass found differences[\s\S]{0,200}?return 1/,
    )
  })

  it('aborts before renaming anything if the copy did not verify', () => {
    // Order is the safety property: a rename that happens before verification leaves the old path
    // empty and the new one wrong, which is the worst of both.
    const copyIndex = directives.indexOf('copy_tree "$SRC_FEDBENCH"')
    const renameIndex = directives.indexOf('.pre-relocate')
    expect(copyIndex, 'the copy must appear in the script').toBeGreaterThan(-1)
    expect(renameIndex, 'the rename must appear in the script').toBeGreaterThan(-1)
    expect(copyIndex, 'the copy and its verification must come before any rename').toBeLessThan(renameIndex)
    expect(directives, 'a failed copy must exit rather than continue').toMatch(
      /copy_tree "\$SRC_FEDBENCH"[^\n]*\|\|[^\n]*exit 1/,
    )
  })

  it('preserves ownership, ACLs and SELinux labels through the copy', () => {
    // -a alone loses xattrs, and on this host that means every SELinux label. A tree that arrives
    // unlabeled_t is denied to confined services with an error naming the service, not the label.
    expect(directives, 'rsync must carry hard links, ACLs and xattrs').toMatch(/rsync -aHAX/)
    expect(directives, 'and must not remap uids').toMatch(/--numeric-ids/)
    expect(directives, 'the new tree needs an fcontext rule, not just a restorecon').toMatch(/semanage fcontext/)
    expect(directives, 'and the labels must actually be applied').toMatch(/restorecon -R/)
  })

  it('stops the writers first and restores them on every exit path', () => {
    // rsync cannot make a consistent copy of a tree something is appending to, and a script that
    // leaves the object store stopped because it failed halfway is worse than one that never ran.
    expect(directives, 'the object store and the timers must be stopped').toMatch(/WRITERS=.*fed-storage\.service/)
    expect(directives, 'an EXIT trap must bring them back').toMatch(/trap restart_writers EXIT/)
  })

  it('refuses a destination that would not actually move the data', () => {
    // Relocating onto the same filesystem changes nothing about the risk while reporting success.
    expect(directives, 'the destination must be a different filesystem from /').toMatch(
      /stat -c %d \/[\s\S]{0,120}?stat -c %d "\$DEST"/,
    )
    expect(directives, 'and being a mount point is not enough on its own').toMatch(/moving there protects nothing/)
  })

  it('has a --check that changes nothing', () => {
    // Every other deploy script here offers one, and a relocation is the last place to break that
    // habit: the rehearsal is how you find out the destination is wrong before the data moves.
    expect(directives).toMatch(/CHECK=1/)
    expect(directives, '--check must exit before the first mutation').toMatch(
      /if \[ "\$CHECK" -eq 1 \][\s\S]{0,400}?exit 0/,
    )
    const checkExit = directives.search(/if \[ "\$CHECK" -eq 1 \]/)
    const firstMutation = directives.search(/systemctl stop|rsync -aHAX|mv "\$target"/)
    expect(checkExit, 'the --check gate must precede any mutation').toBeLessThan(firstMutation)
  })
})

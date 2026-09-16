import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BASH = spawnSync('bash', ['--version']).status === 0;
const script = resolve('deploy/backup-offhost.sh');
const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fedbench-offhost-'));
  tempDirs.push(dir);
  return dir;
}

function pair(dir: string, day: string, body: string, mtime: number) {
  const dump = join(dir, `fedbench-${day}.dump`);
  const sql = join(dir, `fedbench-${day}.sql.gz`);
  writeFileSync(dump, `dump-${body}`);
  writeFileSync(sql, `sql-${body}`);
  utimesSync(dump, mtime, mtime);
  utimesSync(sql, mtime, mtime);
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// These suites spawn bash once or more per assertion. Under the full suite's parallelism that
// exceeds vitest's 5s default and the run fails on TIME, not on behaviour -- a red suite that
// says nothing about the code is worse than a slow one. Scoped here rather than raised
// globally, so a genuinely hanging test elsewhere still fails fast.
describe.runIf(BASH)('backup-offhost', { timeout: 30_000 }, () => {
  it('copies the newest-by-mtime pair under final names and reports verification', () => {
    const source = tempDir();
    const dest = tempDir();
    // DISCRIMINATING on purpose: the mtime-newest file must sort LAST by name, so a selection
    // that walked the glob in order would pick the wrong one. The first version had the
    // mtime-newest file first alphabetically too, so name-order and mtime-order agreed and the
    // test could not tell them apart -- it passed against a mutant that ignored mtime entirely.
    pair(source, '2026-01-01', 'older-mtime', 1_000_000_000);
    pair(source, '2026-02-01', 'newer-mtime', 2_000_000_000);

    const result = run(['--source', source, '--dest', dest]);

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/sha256 source=destination/);
    expect(result.stdout + result.stderr).toMatch(/total bytes/);
    expect(() => accessSync(join(dest, 'fedbench-2026-02-01.dump'))).not.toThrow();
    expect(() => accessSync(join(dest, 'fedbench-2026-02-01.sql.gz'))).not.toThrow();
    expect(() => accessSync(join(dest, 'fedbench-2026-01-01.dump'))).toThrow();
  });

  it('removes an unverified copy and leaves no final pair when the write is short', () => {
    // THE CONTROL, and it now simulates the real failure instead of lying about the hash tool.
    // The first version shimmed sha256sum and keyed off its filename ARGUMENT; the script now
    // redirects the file into sha256sum's stdin -- because GNU sha256sum escapes its output line
    // with a leading backslash for a filename containing one -- so the shim never fired and the
    // control silently stopped controlling anything.
    //
    // A short write is the thing this script exists to catch: cp exits 0, the bytes on the
    // destination are wrong, and nothing else in the stack notices.
    const source = tempDir();
    const dest = tempDir();
    const shim = tempDir();
    pair(source, '2026-01-01', 'current', 2_000_000_000);
    writeFileSync(
      join(shim, 'cp'),
      '#!/usr/bin/env bash\n' +
        '# Copy, then truncate: a write that lands short without reporting an error.\n' +
        'args=(); for a in "$@"; do [ "$a" = "--" ] || args+=("$a"); done\n' +
        '/usr/bin/cp "${args[@]}"\n' +
        'dst="${args[${#args[@]}-1]}"\n' +
        'printf %s "truncated" > "$dst"\n',
    );
    chmodSync(join(shim, 'cp'), 0o755);

    const result = run(['--source', source, '--dest', dest], {
      PATH: `${shim}:${process.env.PATH}`,
    });

    expect(result.status, 'a short write must not report a successful backup').not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/verification failed/);
    // And nothing may be left under a final name: a file with the real name is later read as a
    // valid recovery point by anything that lists the destination.
    expect(() => accessSync(join(dest, 'fedbench-2026-01-01.dump'))).toThrow();
    expect(() => accessSync(join(dest, 'fedbench-2026-01-01.sql.gz'))).toThrow();
    // Nor may a temporary file survive to accumulate.
    expect(readdirSync(dest).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('fails a check when the destination cannot create its writability probe and leaves nothing', () => {
    const source = tempDir();
    const dest = tempDir();
    const shim = tempDir();
    writeFileSync(join(shim, 'mktemp'), `#!/usr/bin/env bash\ncase "$1" in "$UNWRITABLE_DEST"/*) exit 1 ;; *) /usr/bin/mktemp "$@" ;; esac\n`);
    chmodSync(join(shim, 'mktemp'), 0o755);

    const result = run(['--source', source, '--dest', dest, '--check'], {
      PATH: `${shim}:${process.env.PATH}`,
      UNWRITABLE_DEST: dest,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/cannot create a writability probe/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it('warns when the source and destination are on the same device', () => {
    const source = tempDir();
    const dest = tempDir();
    const result = run(['--source', source, '--dest', dest, '--check']);

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/OFF-HOST WARNING/);
  });

  it('keeps the newest destination pairs and prunes older complete pairs', () => {
    const source = tempDir();
    const dest = tempDir();
    pair(source, '2026-01-04', 'current', 4_000_000_000);
    pair(dest, '2026-01-03', 'previous', 3_000_000_000);
    pair(dest, '2026-01-02', 'old', 2_000_000_000);
    pair(dest, '2026-01-01', 'oldest', 1_000_000_000);

    const result = run(['--source', source, '--dest', dest, '--keep', '2']);

    expect(result.status).toBe(0);
    expect(() => accessSync(join(dest, 'fedbench-2026-01-04.dump'))).not.toThrow();
    expect(() => accessSync(join(dest, 'fedbench-2026-01-03.dump'))).not.toThrow();
    expect(() => accessSync(join(dest, 'fedbench-2026-01-02.dump'))).toThrow();
    expect(() => accessSync(join(dest, 'fedbench-2026-01-01.dump'))).toThrow();
  });
});

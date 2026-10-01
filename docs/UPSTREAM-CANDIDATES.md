# Candidate improvements

Improvements to tools this project depends on that other people would want too. None
has been posted anywhere. Any issue or pull request to a repository we do not own follows the
owner's oss-contributions rules and waits for their sign-off. Ordinary workarounds and local
preferences stay out of this list.

## npm: `npm unpublish` reports success when the registry refused it

Observed with npm 11.19.1 (libnpmpublish 11.2.0) on 2026-09-24, unpublishing 0.1.0 of this
package inside npm's 72-hour window. The command line's npm sign-in had expired.
`npm unpublish care-album-saver@0.1.0` printed `- care-album-saver@0.1.0` and exited 0 at
least twice, and the version stayed published. `--verbose` shows why:

```
npm http fetch GET 200 https://registry.npmjs.org/care-album-saver?write=true
npm http fetch PUT 404 https://registry.npmjs.org/care-album-saver/-rev/5-922b3eaef5ef029423f82022db611696
- care-album-saver@0.1.0
npm verbose exit 0
```

The registry answers 404 to a write it will not accept, so that it never reveals that a
private package exists. `unpublish()` in `workspaces/libnpmpublish/lib/unpublish.js` wraps the
read and the writes in one `try`, and its `catch` returns `true` for any `E404`. That is
unchanged in libnpmpublish 12.0.1. After `npm login` the same command worked.

[npm/cli#7120](https://github.com/npm/cli/issues/7120) (2024) reported the same symptom with an
automation token. It was closed: npm cannot tell a 404 from a bad token, and unpublishing a
version that does not exist must keep exiting cleanly, so changing it would be breaking.

**Worth proposing, narrower than #7120's request.** `unpublish()` already returns `true` for a
version the registry's record does not list, before it writes anything, so the clean exit for
a missing version does not depend on the `catch`. After a `GET` that returned the record with
the version in it, a 404 on the `PUT` or `DELETE` cannot mean "already gone", and it reveals
nothing the `GET` had not. Rethrowing `E404` from the writes only, with a hint to check
`npm whoami`, keeps both behaviours the maintainer defended. A smaller alternative: read the
record again after the write and fail if the version is still listed. Either needs a test
against npm's mock registry, and the reply has to answer #7120's argument head on.

Here, [UPDATE-CHECK.md](UPDATE-CHECK.md) now says to confirm an unpublish with
`npm view … --prefer-online` rather than trust the exit code.

## pnpm: `pnpm setup` on a Homebrew pnpm breaks pnpm

Observed on 2026-10-01 with pnpm 12.6.0 from Homebrew on macOS, following pnpm's own advice:
`pnpm add -g .` refused until its global bin folder was on the PATH and said to run
`pnpm setup`. That printed `Installing pnpm CLI globally from /opt/homebrew/bin` and wrote a
global `package.json` holding `"@pnpm/exe": "file:/opt/homebrew/bin"`: the folder Homebrew
keeps every command in, installed as though it were pnpm. It then put `pnpm`, `pnpx`, `pn`
and `pnx` shims into `$PNPM_HOME/bin`, which the lines it added to `~/.zshrc` put ahead of
Homebrew on the PATH. The shims run `node_modules/@pnpm/exe/pnpm` in that global folder,
whose link leads into a virtual-store entry that was never created. From the next shell on,
every `pnpm` command failed with "No such file or directory". Moving the four shims and the
global folder aside brought Homebrew's pnpm back.

[pnpm#15494](https://github.com/pnpm/pnpm/issues/15494) (`pnpm setup` failing with ETXTBSY
while writing its shims, closed 2026-09-24) is nearby, but not this.

Worth investigating upstream: a pnpm installed by another package manager should have
`setup` add its bin folder to the PATH and nothing more, rather than install itself from
the folder its executable happens to be in, and no shim should be written to a target that
does not exist. First reproduce it in a throwaway `HOME` on the latest pnpm (12.8.2 when
this was written); that has not been done.

Here, the README no longer needs pnpm for the command: npm links it.

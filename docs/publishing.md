# Publishing this fork

The three `@2mangoes/*` packages publish publicly to `https://registry.npmjs.org`.
The workspace root stays private. TypeScript sources run directly with Bun;
there is no build step. Existing private GitHub Packages copies are separate
artifacts; this workflow neither updates nor deletes them.

## Publishing credentials

Store the npm token in the fork's Actions secret `NPM_ORG_2MANGOES_TOKEN`.
From a shell where that environment variable is already set:

```sh
printf '%s' "$NPM_ORG_2MANGOES_TOKEN" |
  gh secret set NPM_ORG_2MANGOES_TOKEN --repo 2mangoes/shortsight
```

Never put the token in tracked files, command-line arguments, or chat. The token
needs **Packages and scopes → Read and write (publish and stage)** for
`@2mangoes`, plus **Bypass two-factor authentication** for unattended publishing.
Organization-management read/write permission alone does not grant publishing
permission. The npm account must also have permission to publish in the scope.
Token expiration and any IP restrictions must permit the Actions runner.

The workflow uses `contents: read`; it does not need GitHub Packages write
permission. `setup-node` configures npm authentication through `NODE_AUTH_TOKEN`,
which is supplied from the secret only to the real publish step.

## Prepare and validate

1. Keep all three package versions coordinated, including the exact engine
   dependency in pi-shorthand and optional sightread peer in shorthand-code.
   Version `0.14.0` is retained for the first npmjs release; publishing that
   version previously to GitHub Packages does not publish it on npmjs.
2. Run `npm install --package-lock-only` after version changes, then `npm ci`,
   `npm run check`, and `./scripts/test-linux.sh`.
3. Commit and push the intended release changes to the fork's `main` branch.
   Do not include local skills, credentials, or private Operator memory.
4. In the fork's **Actions → Publish npm packages → Run workflow**, select
   `main` and leave **publish** unchecked. This installs dependencies and
   dry-runs every package without repeating source checks or the Linux suite.
   It uploads nothing; it checks packaging, not release readiness.

The workflow refuses other repositories and branches. Each package manifest
pins the npmjs registry and `access: public`, so first publication is public
without a separate visibility-setting step.

## Publish explicitly

After reviewing the dry run, run the same workflow with **publish** checked.
Only this mode runs source checks and the supported Linux suite before
publishing sightread, shorthand-code, then pi-shorthand. Nothing publishes on
push, tag creation, or GitHub release creation.

Publication is not atomic: if a later upload fails, earlier uploads remain.
Inspect npmjs versions before retrying; do not blindly rerun an already
partially published version. A fully new coordinated version is the simplest
recovery without changing or deleting published artifacts.

## Install and verify

Public npm packages do not require login. If this scope was previously mapped
to GitHub Packages, follow the [registry setup](../README.md#npm-registry-setup)
first. Update any project-level mapping too; it overrides the user-level one.

```sh
pi install npm:@2mangoes/pi-shorthand@0.14.0
npm i -g @2mangoes/sightread@0.14.0
# Or the standalone editing CLI:
npm i -g @2mangoes/shorthand-code@0.14.0

shorthand --help
sightread --help
```

The optional graph package must match the engine version. Upstream unscoped
sightread does not satisfy this fork's graph discovery. The CLI names are still
`shorthand` and `sightread`, so upstream and fork global installs can collide.
Remove or disable an existing upstream/local Pi extension before loading the
fork to avoid registering the shorthand tool twice. Restart Pi after installing.

## Sources

- [Publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [Token permissions, scope selection, and bypass 2FA](https://docs.npmjs.com/creating-and-viewing-access-tokens/)
- [Tokens in CI/CD workflows](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/)

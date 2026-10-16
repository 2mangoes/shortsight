# Publishing this fork

The three `@2mangoes/*` packages publish to GitHub Packages, linked to
`2mangoes/shortsight`. The workspace root stays private. TypeScript sources run
directly with Bun; there is no build step.

## Prepare and validate

1. Keep all three package versions coordinated, including the exact engine
   dependency in pi-shorthand and optional sightread peer in shorthand-code.
   Version `0.14.0` is retained for the first scoped release; it is a different
   package identity from upstream.
2. Run `npm install --package-lock-only` after version changes, then `npm ci`,
   `npm run check`, and `./scripts/test-linux.sh`.
3. Commit and push the intended release changes to the fork's `main` branch.
   Do not include local skills, credentials, or private Operator memory.
4. In the fork's **Actions → Publish GitHub Packages → Run workflow**, select
   `main` and leave **publish** unchecked. This installs dependencies, checks
   the source, runs the supported Linux suite, and dry-runs every package.
   It uploads nothing.

The workflow refuses other repositories and branches. It uses the repository's
automatic `GITHUB_TOKEN` with `contents: read` and `packages: write`; no PAT
secret is needed for publishing. Repository policies must permit Actions package
writes. Existing packages must grant this repository Actions access.

## Publish explicitly

After reviewing the dry run, run the same workflow with **publish** checked.
It repeats validation and publishes sightread, shorthand-code, then pi-shorthand.
Nothing publishes on push, tag creation, or GitHub release creation.

Publication is not atomic: if a later upload fails, earlier uploads remain.
Inspect the package versions before retrying; do not blindly rerun an already
partially published version. A fully new coordinated version is the simplest
recovery without changing or deleting published artifacts.

## Make the first release public

GitHub initially creates npm packages as **private**, even when the linked
repository is public. After the first publication, for **each** of the three
packages:

1. Open your GitHub profile's **Packages** tab and select the package.
2. Open **Package settings**.
3. Under **Danger Zone → Change visibility**, select **Public** and confirm.

Public visibility cannot be reversed to private. Check the contents before
confirming. The workflow does not change visibility. Verify that all three are
public; otherwise an install can fail on a private dependency.

Public package usage is free under GitHub's current policy. Private package
usage and Actions usage have separate allowances and may incur charges.

## Install and verify

Follow the [registry authentication setup](../README.md#github-packages-authentication)
first: even public npm packages on GitHub require authentication with a classic
PAT carrying `read:packages`. Keep tokens in user-level npm credentials, never
tracked files. The committed `.npmrc` maps only `@2mangoes`; package manifests
also pin the publish registry to prevent accidental npmjs publication.

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

- [GitHub npm registry: authentication, scoped names, linking, initial visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
- [Actions publishing and token permissions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)
- [Package visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)

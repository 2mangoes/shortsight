# `shortsight`

Two tools for coding agents working on TypeScript and JavaScript repositories:

- `sightread` shows how a codebase fits together, so an agent reads only the code it needs.
- `shorthand` lets an agent change a repository by writing a small program, so a change that touches many files is one step instead of many.

Each works on its own.

This is the `2mangoes` fork. Its packages use the `@2mangoes` scope on the public npm registry; the CLI names are unchanged. No login is needed to install public packages.

## npm registry setup

If you previously configured this scope for GitHub Packages, point it to npmjs before installing, including when Pi installs into its own npm directory:

```sh
npm config set @2mangoes:registry https://registry.npmjs.org --location=user
```

Remove or update any project-level `@2mangoes:registry` entry that still points to GitHub Packages. No GitHub token is needed. See [publishing instructions](docs/publishing.md) for maintainers.

## `sightread`

![What a change to getMimeType affects in hono](https://raw.githubusercontent.com/2mangoes/shortsight/main/docs/sightread.png)

`sightread` shows what calls what in a TypeScript codebase, and the exact lines each piece of code spans. It asks the TypeScript compiler, so it follows imports, aliases and re-exports that text search misses.

### Install

It runs on [Node](https://nodejs.org) 22 or later, or [Bun](https://bun.sh) 1.4 or later:

```sh
npm i -g @2mangoes/sightread
```

Usage is in [`sightread`'s README](packages/sightread/README.md).

## `shorthand`

![A shorthand call in Pi](https://raw.githubusercontent.com/2mangoes/shortsight/main/docs/shorthand.png)

Instead of a patch, the agent writes a Bun program that can search, rewrite syntax, and rename or move TypeScript symbols. The program edits a private copy of the repository, and the agent sees the diff of what it changed. Agents are good at improving things a step at a time, so changes are applied a whole file at a time and the agent is told which worked and which didn't.

### Install

Install [Bun](https://bun.sh) 1.4 or later:

```sh
curl -fsSL https://bun.sh/install | bash
```

On macOS, install clang and AgentFS:

```sh
xcode-select --install
curl -fsSL https://agentfs.ai/install | bash
```

On Linux, install bubblewrap 0.11 or later, a C compiler, and `lsof`. For Debian and Ubuntu, check the available bubblewrap version before installing:

```sh
apt-cache policy bubblewrap
sudo apt install bubblewrap build-essential lsof
```

Then install it for [Pi](https://github.com/earendil-works/pi), which gives Pi a `shorthand` tool:

```sh
pi install npm:@2mangoes/pi-shorthand
```

Or install the `shorthand` command, for other agents and scripts:

```sh
npm i -g @2mangoes/shorthand-code
```

Usage is in [pi-shorthand's README](packages/pi-shorthand/README.md) and [shorthand-code's README](packages/shorthand-code/README.md).

## Together

With `sightread` installed, `shorthand` programs can ask the same questions, then edit what they find in the same step.

## Local checkout installation

Use this to test the source in this fork rather than the published npm packages. Install Bun 1.4 or later, Node.js/npm, and the platform prerequisites above first. Pi is only needed for the Pi integration.

### 1. Prepare the checkout

```sh
git clone https://github.com/2mangoes/shortsight.git
cd shortsight
npm ci
```

If you already have this checkout, run `npm ci` at its root instead. The workspace packages run directly from TypeScript; no build is needed.

### 2. Use the local commands

From the checkout root:

```sh
export SHORTSIGHT_DIR="$PWD"
export PATH="$SHORTSIGHT_DIR/node_modules/.bin:$PATH"

command -v sightread
command -v shorthand
shorthand --help
sightread --cwd "$SHORTSIGHT_DIR" '{"type":"lookup","query":"runWithBun"}'
```

Both command paths should point into this checkout's `node_modules/.bin`. These exports apply to the current shell and programs started from it; repeat them in a new terminal. No global npm installation is required.

To work on another repository, change into it or pass `--cwd`:

```sh
sightread --cwd /path/to/project '{"type":"overview"}'
printf 'console.log("shorthand works")\n' | shorthand --cwd /path/to/project
```

The shorthand example writes nothing. Editing requires a Git worktree; sightread requires a TypeScript project with a `tsconfig.json`.

### 3. Load the local Pi extension (optional)

Start Pi from the repository you want to work on, keeping the environment from step 2:

```sh
cd /path/to/project
pi -e "$SHORTSIGHT_DIR/packages/pi-shorthand"
```

This loads the local extension for one invocation without saving settings. If an npm copy of pi-shorthand is already configured, remove or disable it first to avoid registering the tool twice (`pi remove npm:pi-shorthand` for a personal npm installation).

To keep the local extension enabled in future sessions:

```sh
pi install "$SHORTSIGHT_DIR/packages/pi-shorthand"
```

Restart Pi after installing it. Pi loads directly from that directory, so keep the checkout in place. The workspace also supplies local sightread for shorthand's `graph.query`; the PATH setting makes its CLI available to shell tools.

### 4. Update and check

After pulling changes from your fork, run `npm ci` again and restart Pi to load the updated source:

```sh
npm --prefix "$SHORTSIGHT_DIR" ci
npm --prefix "$SHORTSIGHT_DIR" audit
```

A local installation uses the checkout's dependencies, not a security sandbox. Review programs and diffs, and run the target project's tests after editing.

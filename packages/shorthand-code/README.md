# shorthand-code

The engine behind [pi-shorthand](https://github.com/2mangoes/shortsight/tree/main/packages/pi-shorthand). It runs a TypeScript program with Bun against a private copy of a repository, then applies the program's changes and prints the diff.

If you use Pi, install pi-shorthand instead. This package is for other agents and scripts, through the `shorthand` command.

## Install

This fork uses GitHub Packages. Complete the [registry authentication setup](https://github.com/2mangoes/shortsight#github-packages-authentication) first, even for public packages.

Install Bun and your platform's sandbox tools, following [pi-shorthand's install steps](https://github.com/2mangoes/shortsight/tree/main/packages/pi-shorthand#install), then:

```sh
npm i -g @2mangoes/shorthand-code
```

For installation from a local checkout instead of npm, see the [local checkout guide](../../README.md#local-checkout-installation).

## Use

Pass a program on stdin, or as a file:

```sh
echo 'edit({ path: "README.md", oldText: "Hello", newText: "Hi" })' | shorthand
```

Programs get the same helpers as pi-shorthand's `shorthand` tool. `shorthand --skill` prints the skill that explains them, and `shorthand --help` lists the options.

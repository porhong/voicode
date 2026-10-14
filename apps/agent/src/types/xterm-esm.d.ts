/*
 * The xterm packages ship CommonJS bundles whose named exports Node's ESM loader cannot
 * see, plus `.mjs` builds that have no type declarations of their own. The agent imports
 * the `.mjs` files (which also lets the standalone build bundle them) and borrows the
 * types from the packages' main entry points.
 */
declare module '@xterm/headless/lib-headless/xterm-headless.mjs' {
  export * from '@xterm/headless';
}
declare module '@xterm/addon-serialize/lib/addon-serialize.mjs' {
  export * from '@xterm/addon-serialize';
}

<div align="center">

# 🔥 deoptkit

A V8 deoptimization toolkit for JavaScript and TypeScript on Node.js — visibility into inline cache states, deoptimizations, hidden-class (map) churn, and CPU profile data, packaged for AI agents and everyday dev workflows.

</div>

---

## Packages

| Package                                             | Description                                                                                                                                            | npm                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| [`deoptkit`](./packages/deoptkit)                   | MCP server, findings engine, benchmark harness, and fix-verify comparison                                                                              | [npm](https://www.npmjs.com/package/deoptkit) |
| [deoptkit (Claude Code plugin)](./plugins/deoptkit) | Install with `/plugin marketplace add Saeris/deoptkit`, then `/plugin install deoptkit@deoptkit`: registers the MCP server and adds the workflow skill | —                                             |
| [`deoptkit-vscode`](./extensions/deoptkit-vscode)   | VSCode extension (marketplace id `saeris.deoptkit-vscode`): starts `deoptkit lsp` and shows findings as inline diagnostics                             | —                                             |

## Contributing

The project uses [Vite+][viteplus] as a unified toolchain (Oxlint + Oxfmt + tsdown + Vitest) and [Bumpy][bumpy] for versioning and release. Run everything from the repository root:

```bash
vp install                     # install dependencies for every workspace package
vp check --fix                 # format + lint + typecheck (with autofixes)
vp test                        # run Vitest across the workspace
vp -C packages/deoptkit pack   # build the deoptkit package
```

Design and roadmap: [docs/SPEC.md](./docs/SPEC.md) and [docs/BENCHMARKING.md](./docs/BENCHMARKING.md). Usage recipes: [docs/recipes.md](./docs/recipes.md). Implementation plans: [plans/README.md](./plans/README.md).

## License

Released under the [MIT license][license] © [Drake Costa][personal-website].

[viteplus]: https://viteplus.dev/
[bumpy]: https://bumpy.varlock.dev/
[license]: ./LICENSE.md
[personal-website]: https://saeris.gg

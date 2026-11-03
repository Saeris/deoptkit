# deoptkit plugin for Claude Code

This plugin installs two things:

- the `deopt` MCP server, started with `npx -y deoptkit@latest`, which gives Claude tools to profile a Node.js workload under V8 logging, rank what is wrong, and compare before and after;
- a `deoptkit` skill that teaches the profile, findings, fix, compare workflow.

Install it from Claude Code:

```
/plugin marketplace add Saeris/deoptkit
/plugin install deoptkit@deoptkit
```

The plugin only registers the published npm package; the engine, tool reference, and recipes live in the [deoptkit package README](../../packages/deoptkit/README.md).

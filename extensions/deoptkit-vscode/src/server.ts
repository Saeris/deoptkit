// Stdio entry for the server bundled with the extension; `deoptkit lsp` behaviour.
import { runLsp } from "deoptkit/lsp";

// CJS output has no top-level await, so the entry is an async function.
const main = async (): Promise<void> => {
  try {
    process.exitCode = await runLsp(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`deoptkit lsp failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
};

void main();

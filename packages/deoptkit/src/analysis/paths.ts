import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Present a script location the way an agent's file tools want it: a forward-slash
 * path relative to `root` for files inside the workspace, an absolute forward-slash
 * path for files outside it, and the input unchanged when it is not a file at all
 * (`node:` internals, eval'd code, unparsable URLs).
 */
export const toWorkspacePath = (file: string, root: string): string => {
  let path: string;
  if (file.startsWith("file:")) {
    try {
      path = fileURLToPath(file);
    } catch {
      return file;
    }
  } else if (isAbsolute(file)) {
    path = file;
  } else {
    return file;
  }
  const rel = relative(resolve(root), path);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return (inside ? rel : path).replaceAll("\\", "/");
};

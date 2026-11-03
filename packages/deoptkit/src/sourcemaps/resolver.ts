import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { LogModel } from "../model/logModel";
import type { Session } from "../sessions";

export interface OriginalPosition {
  file: string;
  line: number;
  column: number;
}

/** Last `//# sourceMappingURL=...` comment in a script (also matches `//@` and CSS-style). */
const SOURCE_MAPPING_URL_RE =
  /\/[/*][#@]\s*sourceMappingURL=(?<url>\S+)\s*(?:\*\/\s*)?$/u;

const INLINE_MAP_RE = /^data:application\/json[^,]*;base64,(?<payload>.+)$/u;

export class SourceMapResolver {
  #model: LogModel;
  /** Script URL -> TraceMap, or null when the script has no usable map. */
  #cache = new Map<string, TraceMap | null>();

  constructor(model: LogModel) {
    this.#model = model;
  }

  /** The executed script's text: prefer what V8 embedded in the log, else read disk. */
  #scriptText(file: string): string | undefined {
    const embedded = this.#model.scripts.get(file);
    if (embedded !== undefined) return embedded;
    try {
      return readFileSync(
        file.startsWith("file:") ? fileURLToPath(file) : file,
        "utf8"
      );
    } catch {
      return undefined;
    }
  }

  #loadMap(file: string): TraceMap | null {
    const text = this.#scriptText(file);
    if (text === undefined) return null;
    // Inline data-URL maps run to many KB, so take the whole line containing the last
    // sourceMappingURL marker rather than scanning a fixed-size tail.
    const marker = text.lastIndexOf("sourceMappingURL=");
    if (marker === -1) return null;
    const lineStart = text.lastIndexOf("\n", marker) + 1;
    const lineEnd = text.indexOf("\n", marker);
    const line = text
      .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      .trimEnd();
    const match = SOURCE_MAPPING_URL_RE.exec(line);
    const url = match?.groups?.["url"];
    if (url === undefined) return null;

    const inline = INLINE_MAP_RE.exec(url);
    try {
      if (inline?.groups) {
        return new TraceMap(
          Buffer.from(inline.groups["payload"] ?? "", "base64").toString("utf8")
        );
      }
      const scriptPath = file.startsWith("file:") ? fileURLToPath(file) : file;
      const mapPath = resolvePath(dirname(scriptPath), decodeURIComponent(url));
      return new TraceMap(readFileSync(mapPath, "utf8"));
    } catch {
      return null;
    }
  }

  /** Map a generated (1-based line/column) position back to its original source. */
  resolve(
    file: string | undefined,
    line: number,
    column: number
  ): OriginalPosition | undefined {
    if (file === undefined) return undefined;
    let map = this.#cache.get(file);
    if (map === undefined) {
      map = this.#loadMap(file);
      this.#cache.set(file, map);
    }
    if (map === null) return undefined;
    // trace-mapping expects 1-based lines and 0-based columns.
    const position = originalPositionFor(map, {
      line,
      column: Math.max(0, column - 1)
    });
    if (position.source === null) return undefined;
    let sourceUrl: string;
    if (position.source.startsWith("file:")) {
      sourceUrl = position.source;
    } else {
      const scriptPath = file.startsWith("file:") ? fileURLToPath(file) : file;
      sourceUrl = pathToFileURL(
        resolvePath(dirname(scriptPath), position.source)
      ).href;
    }
    return {
      file: sourceUrl,
      line: position.line,
      column: position.column + 1
    };
  }
}

const resolvers = new WeakMap<Session, SourceMapResolver>();

/** One lazily-built resolver per session; TraceMaps are cached inside it. */
export const resolverFor = (session: Session): SourceMapResolver => {
  let resolver = resolvers.get(session);
  if (!resolver) {
    resolver = new SourceMapResolver(session.model);
    resolvers.set(session, resolver);
  }
  return resolver;
};

/** Attach `original` to any located item when a source map resolves its position. */
export const withOriginal = <
  T extends { file?: string | undefined; line: number; column: number }
>(
  resolver: SourceMapResolver,
  item: T
): T & { original?: OriginalPosition } => {
  const original = resolver.resolve(item.file, item.line, item.column);
  return original ? { ...item, original } : item;
};

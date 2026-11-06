import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const sourceName = "README.md";

// Project Pages site. `npm run build` with no flag publishes this path.
const defaultBase = "/LoongEnv_Doc/";

function normalizeBase(input) {
  const raw = String(input ?? "").trim();
  if (raw === "/") return "/";
  if (raw === "") return defaultBase;
  let base = raw.startsWith("/") ? raw : `/${raw}`;
  base = base.replace(/\/{2,}/g, "/");
  if (!base.endsWith("/")) base += "/";
  return base;
}

function readBase(argv) {
  const inline = argv.find((arg) => arg.startsWith("--base="));
  if (inline) return normalizeBase(inline.slice("--base=".length));
  const index = argv.indexOf("--base");
  if (index === -1) return defaultBase;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--base requires a path, for example --base /LoongEnv_Doc/");
  }
  return normalizeBase(value);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isRemoteOrRooted(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(value);
}

function slugify(text) {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

function uniqueSlug(text, seen) {
  const base = slugify(text);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function readTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "LoongEnv";
}

function readDescription(markdown) {
  const lines = markdown.split(/\r?\n/);
  let seenTitle = false;
  for (const line of lines) {
    if (!seenTitle) {
      if (/^#\s+/.test(line)) seenTitle = true;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">") || trimmed.startsWith("<")) {
      continue;
    }
    return trimmed;
  }
  return "";
}

function referencedFiles(markdown) {
  const found = new Set();
  const patterns = [
    /(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    /!\[[^\]]*]\(([^)\s]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const value = match[1].trim().replace(/^\.\//, "");
      if (!value || isRemoteOrRooted(value)) continue;
      found.add(value.split(/[?#]/)[0]);
    }
  }
  return [...found];
}

function prefixRelativeUrl(value, base) {
  const trimmed = value.trim();
  if (!trimmed || isRemoteOrRooted(trimmed)) return value;
  const relative = trimmed.replace(/^\.\//, "");
  return base === "/" ? `/${relative}` : `${base}${relative}`;
}

function prefixRelativeUrls(html, base) {
  return html.replace(
    /\b(src|href)\s*=\s*(["'])(.*?)\2/gi,
    (full, attr, quote, value) => `${attr}=${quote}${prefixRelativeUrl(value, base)}${quote}`,
  );
}

function headingList(markdown) {
  const seen = new Map();
  return marked
    .lexer(markdown)
    .filter((token) => token.type === "heading" && token.depth >= 2 && token.depth <= 3)
    .map((token) => ({
      depth: token.depth,
      text: token.text,
      id: uniqueSlug(token.text, seen),
    }));
}

function addHeadingIds(html, headings) {
  let index = 0;
  const withIds = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (full, depth, inner) => {
    const heading = headings[index];
    index += 1;
    if (!heading || Number(depth) !== heading.depth) {
      throw new Error("Could not align rendered headings with the Markdown source.");
    }
    return `<h${depth} id="${escapeHtml(heading.id)}">${inner}</h${depth}>`;
  });
  if (index !== headings.length) {
    throw new Error("Could not align rendered headings with the Markdown source.");
  }
  return withIds;
}

function renderToc(headings) {
  if (headings.length === 0) return "";
  const sections = [];
  for (const heading of headings) {
    const link = `<a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`;
    if (heading.depth <= 2 || sections.length === 0) {
      sections.push({ link, children: [] });
    } else {
      sections[sections.length - 1].children.push(link);
    }
  }
  const items = sections
    .map((section) => {
      const nested =
        section.children.length === 0
          ? ""
          : `\n<ol>\n${section.children.map((child) => `<li>${child}</li>`).join("\n")}\n</ol>`;
      return `<li>${section.link}${nested}</li>`;
    })
    .join("\n");
  return `<nav class="toc" aria-label="目录">\n<ol>\n${items}\n</ol>\n</nav>\n`;
}

function insertToc(html, toc) {
  if (!toc) return html;
  const close = "</h1>";
  const at = html.indexOf(close);
  if (at === -1) return `${toc}${html}`;
  return `${html.slice(0, at + close.length)}\n${toc}${html.slice(at + close.length)}`;
}

function wrapTables(html) {
  return html.replaceAll("<table>", '<div class="table-wrap"><table>').replaceAll("</table>", "</table></div>");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const base = readBase(process.argv.slice(2));
  const markdown = await readFile(path.join(root, sourceName), "utf8");
  const title = readTitle(markdown);
  const description = readDescription(markdown);
  const assets = referencedFiles(markdown);
  const headings = headingList(markdown);

  let html = marked.parse(markdown);
  if (html instanceof Promise) html = await html;
  html = addHeadingIds(html, headings);
  html = prefixRelativeUrls(html, base);
  html = wrapTables(html);
  html = insertToc(html, renderToc(headings));

  for (const asset of assets) {
    const published = prefixRelativeUrl(asset, base);
    if (!html.includes(published)) {
      throw new Error(`Built page is missing ${published}`);
    }
    if (!(await exists(path.join(root, asset)))) {
      throw new Error(`Documentation references a missing file: ${asset}`);
    }
  }
  if (base !== "/" && (html.includes('src="assets/') || html.includes("src='assets/"))) {
    throw new Error("Asset paths were not prefixed with the site base.");
  }

  const styleHref = base === "/" ? "/docs.css" : `${base}docs.css`;
  const descriptionTag = description
    ? `\n  <meta name="description" content="${escapeHtml(description)}">`
    : "";
  const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>${descriptionTag}
  <link rel="stylesheet" href="${escapeHtml(styleHref)}">
</head>
<body>
  <main class="doc">
${html}
  </main>
</body>
</html>
`;

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  if (await exists(path.join(root, "assets"))) {
    await cp(path.join(root, "assets"), path.join(distDir, "assets"), { recursive: true });
  }
  await cp(path.join(root, "site", "docs.css"), path.join(distDir, "docs.css"));
  await writeFile(path.join(distDir, "index.html"), page);
  await writeFile(path.join(distDir, ".nojekyll"), "");

  for (const asset of assets) {
    if (!(await exists(path.join(distDir, asset)))) {
      throw new Error(`Build did not publish ${asset}`);
    }
  }

  console.log(`Built ${path.relative(root, path.join(distDir, "index.html"))} with base ${base}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import { Fragment, type ReactNode } from "react";

/**
 * Minimal Markdown subset renderer for admin-authored copy (announcements, changelogs).
 *
 * Deliberately builds React elements instead of HTML strings: nothing reaches
 * dangerouslySetInnerHTML, so authored content cannot inject markup or scripts.
 * Supported: # / ## / ### headings, - * bullets, 1. ordered lists, > callouts,
 * --- dividers, **bold**, *italic*, `code`, and [text](url) links.
 */

const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|`[^`\n]+`|!\[[^\]\n]*\]\([^)\s]+\)|\[[^\]\n]+\]\([^)\s]+\))/g;
const SAFE_LINK = /^(https?:\/\/|mailto:|\/)/i;

function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
    return text
        .split(INLINE_PATTERN)
        .filter((part) => part !== "" && part !== undefined)
        .map((part, index) => {
            const key = `${keyPrefix}-${index}`;
            if (part.startsWith("**") && part.endsWith("**")) {
                return <strong key={key} className="font-semibold text-stone-950 dark:text-stone-100">{part.slice(2, -2)}</strong>;
            }
            if (part.startsWith("~~") && part.endsWith("~~")) {
                return <del key={key} className="text-stone-400 line-through dark:text-stone-500">{part.slice(2, -2)}</del>;
            }
            if (part.startsWith("`") && part.endsWith("`")) {
                return <code key={key} className="rounded bg-stone-950/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-stone-800 dark:bg-white/10 dark:text-stone-200">{part.slice(1, -1)}</code>;
            }
            if (part.startsWith("*") && part.endsWith("*")) {
                return <em key={key}>{part.slice(1, -1)}</em>;
            }
            const imgMatch = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
            if (imgMatch) {
                const [, alt, src] = imgMatch;
                if (!SAFE_LINK.test(src)) return <Fragment key={key}>{part}</Fragment>;
                return (
                    <img
                        key={key}
                        src={src}
                        alt={alt}
                        className="my-2 max-h-80 w-auto max-w-full rounded-lg border border-stone-200 object-contain dark:border-stone-800"
                        loading="lazy"
                    />
                );
            }
            const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
            if (link) {
                const [, label, href] = link;
                // Reject javascript:/data: and other schemes; render them as plain text instead.
                if (!SAFE_LINK.test(href)) return <Fragment key={key}>{part}</Fragment>;
                return (
                    <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-stone-950 underline decoration-stone-400 underline-offset-2 transition hover:decoration-stone-950 dark:text-stone-100 dark:decoration-stone-500 dark:hover:decoration-stone-100">
                        {label}
                    </a>
                );
            }
            return <Fragment key={key}>{part}</Fragment>;
        });
}

type Block =
    | { kind: "heading"; level: number; text: string }
    | { kind: "list"; ordered: boolean; items: string[] }
    | { kind: "quote"; lines: string[] }
    | { kind: "code"; lang: string; code: string }
    | { kind: "divider" }
    | { kind: "paragraph"; lines: string[] };

function parseBlocks(source: string): Block[] {
    const blocks: Block[] = [];
    let inCodeBlock = false;
    let codeLang = "";
    let codeLines: string[] = [];

    for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
        const line = rawLine.trimEnd();

        if (line.startsWith("```")) {
            if (inCodeBlock) {
                blocks.push({ kind: "code", lang: codeLang, code: codeLines.join("\n") });
                inCodeBlock = false;
                codeLang = "";
                codeLines = [];
            } else {
                inCodeBlock = true;
                codeLang = line.slice(3).trim();
                codeLines = [];
            }
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(rawLine);
            continue;
        }

        const previous = blocks.at(-1);
        if (!line.trim()) {
            // A blank line closes whatever block was open; the empty paragraph is dropped later.
            blocks.push({ kind: "paragraph", lines: [] });
            continue;
        }
        if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
            blocks.push({ kind: "divider" });
            continue;
        }
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
            blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
            continue;
        }
        const quote = line.match(/^>\s?(.*)$/);
        if (quote) {
            if (previous?.kind === "quote") previous.lines.push(quote[1]);
            else blocks.push({ kind: "quote", lines: [quote[1]] });
            continue;
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (bullet || ordered) {
            const isOrdered = Boolean(ordered);
            const text = (bullet?.[1] ?? ordered?.[1] ?? "").trim();
            if (previous?.kind === "list" && previous.ordered === isOrdered) previous.items.push(text);
            else blocks.push({ kind: "list", ordered: isOrdered, items: [text] });
            continue;
        }
        if (previous?.kind === "paragraph") previous.lines.push(line);
        else blocks.push({ kind: "paragraph", lines: [line] });
    }

    if (inCodeBlock) {
        blocks.push({ kind: "code", lang: codeLang, code: codeLines.join("\n") });
    }

    return blocks.filter((block) => block.kind !== "paragraph" || block.lines.length > 0);
}

const HEADING_CLASS: Record<number, string> = {
    1: "mt-5 mb-2 text-base font-semibold text-stone-950 first:mt-0 dark:text-stone-100",
    2: "mt-5 mb-2 text-[0.95rem] font-semibold text-stone-950 first:mt-0 dark:text-stone-100",
    3: "mt-4 mb-1.5 text-sm font-semibold text-stone-800 first:mt-0 dark:text-stone-200",
};

export function MarkdownLite({ content, className = "" }: { content: string; className?: string }) {
    const blocks = parseBlocks(content);
    return (
        <div className={`text-sm leading-6 text-stone-600 dark:text-stone-300 ${className}`}>
            {blocks.map((block, index) => {
                const key = `block-${index}`;
                if (block.kind === "divider") return <hr key={key} className="my-4 border-stone-200 dark:border-stone-800" />;
                if (block.kind === "heading") {
                    const Tag = (["h3", "h4", "h5"][block.level - 1] ?? "h5") as "h3" | "h4" | "h5";
                    return <Tag key={key} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[3]}>{inlineNodes(block.text, key)}</Tag>;
                }
                if (block.kind === "quote") {
                    return (
                        <div key={key} className="my-3 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
                            {block.lines.map((line, lineIndex) => (
                                <p key={`${key}-${lineIndex}`} className="m-0">{inlineNodes(line, `${key}-${lineIndex}`)}</p>
                            ))}
                        </div>
                    );
                }
                if (block.kind === "code") {
                    return (
                        <div key={key} className="my-3 overflow-hidden rounded-lg border border-stone-200 bg-stone-900 text-stone-100 dark:border-stone-800 dark:bg-stone-950">
                            {block.lang ? (
                                <div className="border-b border-stone-800 bg-stone-950/60 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-wider text-stone-400">
                                    {block.lang}
                                </div>
                            ) : null}
                            <pre className="overflow-x-auto p-3 font-mono text-xs leading-5 text-stone-200">
                                <code>{block.code}</code>
                            </pre>
                        </div>
                    );
                }
                if (block.kind === "list") {
                    const ListTag = block.ordered ? "ol" : "ul";
                    return (
                        <ListTag key={key} className={`my-2 space-y-1 ps-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
                            {block.items.map((item, itemIndex) => (
                                <li key={`${key}-${itemIndex}`} className="ps-0.5">{inlineNodes(item, `${key}-${itemIndex}`)}</li>
                            ))}
                        </ListTag>
                    );
                }
                return (
                    <p key={key} className="my-2 first:mt-0 last:mb-0">
                        {block.lines.map((line, lineIndex) => (
                            <Fragment key={`${key}-${lineIndex}`}>
                                {lineIndex > 0 ? <br /> : null}
                                {inlineNodes(line, `${key}-${lineIndex}`)}
                            </Fragment>
                        ))}
                    </p>
                );
            })}
        </div>
    );
}

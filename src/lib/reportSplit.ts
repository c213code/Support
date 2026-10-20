// Keep every HTML entity and tag intact, and close/reopen formatting at
// message boundaries. Count markup too, leaving room under Telegram's limit.
export function splitReport(text: string, format: "plain" | "html" = "plain"): string[] {
  const limit = 3900;
  const tokens = format === "html"
    ? text.match(/<[^>]*>|&(?:#\d+|#x[\da-f]+|\w+);|[^<&]+|[<&]/giu) ?? []
    : [text];
  const parts: string[] = [];
  const stack: { open: string; close: string }[] = [];
  const closing = () => [...stack].reverse().map((tag) => tag.close).join("");
  let current = "";
  const flush = () => {
    parts.push(current + closing());
    current = stack.map((tag) => tag.open).join("");
  };
  for (const token of tokens) {
    if (format === "html" && token.startsWith("<") && token.endsWith(">")) {
      if (token.startsWith("</")) {
        stack.pop();
        current += token;
      } else {
        const name = token.match(/^<([\w-]+)/)?.[1];
        if (!name) throw new Error("Invalid report HTML tag");
        const close = `</${name}>`;
        if (current.length + token.length + close.length + closing().length > limit) flush();
        if (current.length + token.length + close.length + closing().length > limit) {
          throw new Error("Report HTML tag exceeds Telegram message limit");
        }
        stack.push({ open: token, close });
        current += token;
      }
      continue;
    }
    // Text runs split at Unicode code points; entities stay indivisible.
    const units = format === "html" && /^&(?:#\d+|#x[\da-f]+|\w+);$/iu.test(token)
      ? [token] : Array.from(token);
    for (const unit of units) {
      if (current.length + unit.length + closing().length > limit) flush();
      current += unit;
    }
  }
  if (current) parts.push(current + closing());
  return parts;
}

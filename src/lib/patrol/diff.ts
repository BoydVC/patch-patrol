export function unifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) return "";
  const left = before.replace(/\r\n/g, "\n").split("\n");
  const right = after.replace(/\r\n/g, "\n").split("\n");
  const table = lcsTable(left, right);
  const raw: Array<{ kind: " " | "+" | "-"; text: string }> = [];
  let i = left.length;
  let j = right.length;
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      raw.push({ kind: " ", text: left[i - 1] });
      i -= 1;
      j -= 1;
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      raw.push({ kind: "-", text: left[i - 1] });
      i -= 1;
    } else {
      raw.push({ kind: "+", text: right[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    raw.push({ kind: "-", text: left[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    raw.push({ kind: "+", text: right[j - 1] });
    j -= 1;
  }
  raw.reverse();
  const body = hunks(raw);
  return [`--- a/${filePath}`, `+++ b/${filePath}`, ...body].join("\n");
}

function lcsTable(left: string[], right: string[]): number[][] {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i][j] =
        left[i - 1] === right[j - 1]
          ? table[i - 1][j - 1] + 1
          : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table;
}

function hunks(lines: Array<{ kind: " " | "+" | "-"; text: string }>): string[] {
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind === " ") {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - 2);
    let end = index;
    while (end < lines.length) {
      if (lines[end].kind === " ") {
        const nextChange = lines.slice(end, end + 4).some((line) => line.kind !== " ");
        if (!nextChange) break;
      }
      end += 1;
    }
    end = Math.min(lines.length, end + 2);
    const slice = lines.slice(start, end);
    const oldCount = slice.filter((line) => line.kind !== "+").length;
    const newCount = slice.filter((line) => line.kind !== "-").length;
    const oldStart = slice.filter((_, offset) => lines[offset]?.kind !== "+").length;
    output.push(`@@ -${Math.max(oldStart, 1)},${oldCount} +${Math.max(oldStart, 1)},${newCount} @@`);
    for (const line of slice) output.push(`${line.kind}${line.text}`);
    index = end;
  }
  return output;
}

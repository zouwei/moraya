import MarkdownIt from 'markdown-it';

export type ImageInsertMode = 'paragraph' | 'end' | 'replace';

const markdownParser = new MarkdownIt();

function removePromptBlocks(markdown: string): string {
  const ranges = markdownParser.parse(markdown, {})
    .filter(token => token.type === 'fence' && /^(?:prompt|image-prompts?)$/.test(token.info.trim()) && token.map)
    .map(token => token.map!);
  if (ranges.length === 0) return markdown;

  const lines = markdown.split('\n');
  const output: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    output.push(...lines.slice(cursor, start));
    while (output.length > 0 && !output[output.length - 1].trim()) output.pop();

    cursor = end;
    while (cursor < lines.length && !lines[cursor].trim()) cursor++;
    if (output.length > 0 && cursor < lines.length) output.push('');
  }
  output.push(...lines.slice(cursor));
  return output.join('\n');
}

export function insertGeneratedImagesIntoMarkdown(
  markdown: string,
  images: { url: string; target: number }[],
  mode: ImageInsertMode,
): string {
  if (images.length === 0) return markdown;

  let result = markdown;
  if (mode === 'end') {
    result = markdown.trimEnd() + '\n\n' + images.map(img => `![](${img.url})`).join('\n\n') + '\n';
  } else if (mode === 'replace') {
    let replaceIdx = 0;
    result = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, match => {
      if (replaceIdx < images.length) return `![](${images[replaceIdx++].url})`;
      return match;
    });
    if (replaceIdx < images.length) {
      const remaining = images.slice(replaceIdx).map(img => `![](${img.url})`).join('\n\n');
      result = result.trimEnd() + '\n\n' + remaining + '\n';
    }
  } else {
    const lines = markdown.split('\n');
    let paraTotal = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() && (i + 1 >= lines.length || !lines[i + 1]?.trim())) paraTotal++;
    }

    const targets = images.map(img => Math.max(0, Math.min(img.target, Math.max(0, paraTotal - 1))));
    if (paraTotal >= 2 && new Set(targets).size < images.length) {
      const segment = paraTotal / images.length;
      for (let i = 0; i < images.length; i++) {
        targets[i] = Math.min(Math.round(segment * i + segment / 2), paraTotal - 1);
      }
    }

    const insertions = new Map<number, string[]>();
    for (let i = 0; i < images.length; i++) {
      const existing = insertions.get(targets[i]) || [];
      existing.push(`![](${images[i].url})`);
      insertions.set(targets[i], existing);
    }

    const inCodeBlockAt: boolean[] = new Array(lines.length).fill(false);
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(lines[i])) {
        inCodeBlockAt[i] = true;
        inBlock = !inBlock;
      } else {
        inCodeBlockAt[i] = inBlock;
      }
    }

    const output: string[] = [];
    let deferredImages: string[] = [];
    let paragraphIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      output.push(lines[i]);
      if (lines[i].trim() && (i + 1 >= lines.length || !lines[i + 1]?.trim())) {
        const imgs = insertions.get(paragraphIdx);
        if (inCodeBlockAt[i]) {
          if (imgs) deferredImages.push(...imgs);
        } else {
          if (deferredImages.length > 0) {
            output.push('', ...deferredImages);
            deferredImages = [];
          }
          if (imgs) output.push('', ...imgs);
        }
        paragraphIdx++;
      }
    }
    if (deferredImages.length > 0) output.push('', ...deferredImages);
    result = output.join('\n');
  }

  return removePromptBlocks(result);
}

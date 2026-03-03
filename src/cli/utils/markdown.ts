// src/cli/utils/markdown.ts
import chalk from 'chalk';
import { Marked } from 'marked';
import hljs from 'highlight.js';

const marked = new Marked();

// Map highlight.js token classes to chalk styles
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function hljsToChalk(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<span class="hljs-keyword">(.*?)<\/span>/g, (_, t) => chalk.magenta(t))
    .replace(/<span class="hljs-string">(.*?)<\/span>/g, (_, t) => chalk.green(t))
    .replace(/<span class="hljs-number">(.*?)<\/span>/g, (_, t) => chalk.yellow(t))
    .replace(/<span class="hljs-comment">(.*?)<\/span>/g, (_, t) => chalk.gray(t))
    .replace(/<span class="hljs-built_in">(.*?)<\/span>/g, (_, t) => chalk.cyan(t))
    .replace(/<span class="hljs-function">(.*?)<\/span>/g, (_, t) => chalk.blue(t))
    .replace(/<span class="hljs-title[^"]*">(.*?)<\/span>/g, (_, t) => chalk.blue(t))
    .replace(/<span class="hljs-params">(.*?)<\/span>/g, (_, t) => t)
    .replace(/<span class="hljs-literal">(.*?)<\/span>/g, (_, t) => chalk.yellow(t))
    .replace(/<span class="hljs-attr">(.*?)<\/span>/g, (_, t) => chalk.cyan(t))
    .replace(/<span class="hljs-[^"]*">(.*?)<\/span>/g, (_, t) => t)
    .replace(/<\/?[^>]+>/g, ''));
}

// marked v17 uses token objects; renderer methods receive `this` with this.parser
import type { Tokens } from 'marked';
const renderer = {
  heading(this: { parser: { parseInline(tokens: unknown[]): string } }, { tokens, depth }: Tokens.Heading) {
    const text = this.parser.parseInline(tokens);
    const prefix = '#'.repeat(depth) + ' ';
    return '\n' + chalk.bold.cyan(prefix + text) + '\n\n';
  },

  paragraph(this: { parser: { parseInline(tokens: unknown[]): string } }, { tokens }: Tokens.Paragraph) {
    return this.parser.parseInline(tokens) + '\n\n';
  },

  strong(this: { parser: { parseInline(tokens: unknown[]): string } }, { tokens }: Tokens.Strong) {
    return chalk.bold(this.parser.parseInline(tokens));
  },

  em(this: { parser: { parseInline(tokens: unknown[]): string } }, { tokens }: Tokens.Em) {
    return chalk.italic(this.parser.parseInline(tokens));
  },

  codespan({ text }: Tokens.Codespan) {
    return chalk.gray.bgBlackBright(' ' + text + ' ');
  },

  code({ text, lang }: Tokens.Code) {
    let highlighted: string;
    if (lang && hljs.getLanguage(lang)) {
      const result = hljs.highlight(text, { language: lang });
      highlighted = hljsToChalk(result.value);
    } else {
      highlighted = text;
    }
    const border = chalk.gray('\u2500'.repeat(40));
    const langLabel = lang ? chalk.gray(` ${lang} `) : '';
    return '\n' + border + langLabel + '\n' + highlighted + '\n' + border + '\n\n';
  },

  list(this: { parser: { parse(tokens: unknown[]): string }; listitem(item: Tokens.ListItem): string }, token: Tokens.List) {
    let body = '';
    for (const item of token.items) {
      body += this.listitem(item);
    }
    return body + '\n';
  },

  listitem(this: { parser: { parse(tokens: unknown[]): string } }, item: Tokens.ListItem) {
    return '  ' + chalk.dim('\u2022') + ' ' + this.parser.parse(item.tokens) + '\n';
  },

  link(this: { parser: { parseInline(tokens: unknown[]): string } }, { href, tokens }: Tokens.Link) {
    const text = this.parser.parseInline(tokens);
    return chalk.blue.underline(text) + chalk.gray(' (' + href + ')');
  },

  blockquote(this: { parser: { parse(tokens: unknown[]): string } }, { tokens }: Tokens.Blockquote) {
    const text = this.parser.parse(tokens);
    const lines = text.split('\n').map(l => chalk.gray('\u2502 ') + chalk.italic(l));
    return lines.join('\n') + '\n';
  },

  hr() {
    return chalk.gray('\u2500'.repeat(40)) + '\n\n';
  },
};

marked.use({ renderer });

export function renderMarkdown(content: string): string {
  if (!content) return '';
  const result = marked.parse(content) as string;
  return decodeHtmlEntities(result).replace(/\n{3,}/g, '\n\n').trimEnd();
}

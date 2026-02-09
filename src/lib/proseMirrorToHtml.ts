type JsonLike = Record<string, unknown>;

type ProseMirrorMark = {
  type?: string;
  attrs?: JsonLike;
};

type ProseMirrorNode = {
  type?: string;
  text?: string;
  attrs?: JsonLike;
  marks?: ProseMirrorMark[];
  content?: ProseMirrorNode[];
};

type ProseMirrorImageResolver = (node: ProseMirrorNode) => string[] | string;

type ProseMirrorToHtmlOptions = {
  resolveImageUrls?: ProseMirrorImageResolver;
};

function normalizeType(type: unknown): string {
  if (typeof type !== 'string') return '';
  return type.toLowerCase().replace(/[_-\s]/g, '');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normalizeImageUrls(
  value: string[] | string | undefined,
  fallback: string | undefined,
): string[] {
  const urls = Array.isArray(value) ? value : value ? [value] : [];
  if (!urls.length && fallback) {
    return [fallback];
  }
  return urls.filter(Boolean);
}

function applyMarks(text: string, marks?: ProseMirrorMark[]): string {
  if (!marks?.length) return text;
  return marks.reduce((rendered, mark) => {
    switch (normalizeType(mark.type)) {
      case 'bold':
      case 'strong':
        return `<b>${rendered}</b>`;
      case 'italic':
      case 'em':
        return `<i>${rendered}</i>`;
      case 'underline':
        return `<u>${rendered}</u>`;
      case 'strike':
      case 's':
        return `<s>${rendered}</s>`;
      case 'code':
        return `<code>${rendered}</code>`;
      case 'link': {
        const href = mark.attrs?.href;
        if (typeof href !== 'string' || !href.trim()) return rendered;
        return `<a href="${escapeAttribute(href)}">${rendered}</a>`;
      }
      default:
        return rendered;
    }
  }, text);
}

function renderNodes(
  nodes: ProseMirrorNode[] | undefined,
  options: ProseMirrorToHtmlOptions,
): string {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(node => renderNode(node, options)).join('');
}

function renderNode(
  node: ProseMirrorNode | undefined,
  options: ProseMirrorToHtmlOptions,
): string {
  if (!node || typeof node !== 'object') return '';

  const type = normalizeType(node.type);
  const children = renderNodes(node.content, options);

  switch (type) {
    case 'doc':
      return children;
    case 'paragraph':
      return `<p>${children || '<br>'}</p>`;
    case 'bulletlist':
      return `<ul>${children || '<br>'}</ul>`;
    case 'orderedlist':
      return `<ol>${children || '<br>'}</ol>`;
    case 'listitem':
      return `<li>${children || '<br>'}</li>`;
    case 'blockquote':
      return `<blockquote>${children || '<br>'}</blockquote>`;
    case 'hardbreak':
      return '<br>';
    case 'horizontalrule':
    case 'delimiter':
      return '<hr>';
    case 'heading': {
      const levelRaw = Number(node.attrs?.level);
      const level = levelRaw >= 1 && levelRaw <= 6 ? levelRaw : 2;
      return `<h${level}>${children || '<br>'}</h${level}>`;
    }
    case 'image': {
      let resolved: string[] | string | undefined;
      if (typeof options.resolveImageUrls === 'function') {
        resolved = options.resolveImageUrls(node);
      }
      const fallbackSrc =
        typeof node.attrs?.src === 'string' ? node.attrs.src : undefined;
      const urls = normalizeImageUrls(resolved, fallbackSrc);
      if (!urls.length) return '';
      const alt =
        typeof node.attrs?.alt === 'string'
          ? ` alt="${escapeAttribute(node.attrs.alt)}"`
          : '';
      return urls
        .map(url => `<img src="${escapeAttribute(url)}"${alt}>`)
        .join('');
    }
    case 'text':
      return applyMarks(escapeHtml(node.text), node.marks);
    default:
      return children;
  }
}

export function proseMirrorToHtml(
  input: ProseMirrorNode[] | ProseMirrorNode | null | undefined,
  options: ProseMirrorToHtmlOptions = {},
): string {
  if (Array.isArray(input)) {
    return renderNodes(input, options);
  }
  if (input && Array.isArray(input.content)) {
    return renderNodes(input.content, options);
  }
  return '';
}

export type {
  ProseMirrorMark,
  ProseMirrorNode,
  ProseMirrorToHtmlOptions,
  ProseMirrorImageResolver,
};

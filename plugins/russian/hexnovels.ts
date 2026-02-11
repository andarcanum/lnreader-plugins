import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { fetchApi } from '@libs/fetch';
import { NovelStatus } from '@libs/novelStatus';
import { proseMirrorToHtml } from '@libs/proseMirrorToHtml';
import { load as parseHTML, type CheerioAPI } from 'cheerio';
import dayjs from 'dayjs';

type ProseMirrorInput = Parameters<typeof proseMirrorToHtml>[0];

type AstroStateValue =
  | string
  | number
  | boolean
  | null
  | AstroStateValue[]
  | { [key: string]: AstroStateValue };

type HexBookData = {
  id?: string;
  slug?: string;
  status?: string;
  name?: string | Record<string, unknown>;
  description?: string | Record<string, unknown>;
  poster?: string;
  averageRating?: number;
  labels?: HexLabel[];
  relations?: HexRelation[];
};

type HexLabel = {
  name?: string;
};

type HexRelation = {
  type?: string;
  publisher?: {
    name?: string;
  };
};

type HexChapterData = {
  id?: string;
  name?: string;
  number?: number | string;
  volume?: number | string;
  branchId?: string;
  createdAt?: string;
};

type HexReaderChapter = {
  content?: ProseMirrorInput | string;
};

const statusMap: Record<string, string> = {
  ONGOING: NovelStatus.Ongoing,
  INPROGRESS: NovelStatus.Ongoing,
  DONE: NovelStatus.Completed,
  COMPLETED: NovelStatus.Completed,
  HIATUS: NovelStatus.OnHiatus,
  PAUSED: NovelStatus.OnHiatus,
  CANCELLED: NovelStatus.Cancelled,
  DROPPED: NovelStatus.Cancelled,
};

class HexNovels implements Plugin.PluginBase {
  id = 'hexnovels';
  name = 'HexNovels';
  icon = 'src/en/hexnovels/icon.png';
  site = 'https://hexnovels.me';
  version = '1.0.1';

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const sortParam = showLatestNovels
      ? 'createdAt,desc'
      : filters?.sort?.value || 'viewsCount,desc';
    const url = `${this.site}/content?page=${pageNo - 1}&size=30&sort=${encodeURIComponent(sortParam)}`;
    return this.fetchNovelItems(url);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = resolvePath(this.site, novelPath);
    const result = await fetchApi(url);
    if (!result.ok) {
      throw new Error(`Could not reach ${url} (${result.status})`);
    }
    const body = await result.text();
    const loadedCheerio = parseHTML(body);

    const astroState = extractAstroState(loadedCheerio);
    const bookData = astroState
      ? getAstroValueByKey<HexBookData>(astroState, 'current-book')
      : null;
    const chaptersData = astroState
      ? getAstroValueByKey<HexChapterData[]>(
          astroState,
          'current-book-chapters',
        )
      : null;

    const headingTitle = loadedCheerio('h1').first().text().trim();
    const metaTitle = loadedCheerio('meta[property="og:title"]')
      .attr('content')
      ?.trim();
    const pageTitle = sanitizeNovelTitle(loadedCheerio('title').text());
    const metaSummary = loadedCheerio('meta[name="description"]')
      .attr('content')
      ?.trim();
    const metaCover = loadedCheerio('meta[property="og:image"]')
      .attr('content')
      ?.trim();

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: headingTitle || metaTitle || pageTitle || '',
      summary: metaSummary,
      cover: metaCover || defaultCover,
    };

    if (bookData) {
      const localizedName = pickLocalizedString(bookData.name);
      if (localizedName) {
        novel.name = localizedName;
      }

      const localizedSummary = pickLocalizedString(bookData.description);
      if (localizedSummary) {
        novel.summary = localizedSummary;
      }

      if (bookData.poster?.trim()) {
        novel.cover = bookData.poster.trim();
      }

      const status = mapNovelStatus(bookData.status);
      if (status) {
        novel.status = status;
      }

      const author = extractAuthor(bookData.relations);
      if (author) {
        novel.author = author;
      }

      const genres = extractGenres(bookData.labels);
      if (genres) {
        novel.genres = genres;
      }

      const rating = normalizeRating(bookData.averageRating);
      if (rating !== undefined) {
        novel.rating = rating;
      }
    }

    const slug = extractNovelSlug(novelPath) || bookData?.slug || '';
    if (chaptersData?.length) {
      const chaptersByBranch = new Map<string, HexChapterData[]>();
      chaptersData.forEach(chapter => {
        const branchId = chapter.branchId || 'default-branch';
        if (!chaptersByBranch.has(branchId)) {
          chaptersByBranch.set(branchId, []);
        }
        chaptersByBranch.get(branchId)?.push(chapter);
      });

      let largestBranch: HexChapterData[] = [];
      chaptersByBranch.forEach(branchChapters => {
        if (branchChapters.length > largestBranch.length) {
          largestBranch = branchChapters;
        }
      });

      const sortedChapters = [...largestBranch].sort((chapterA, chapterB) => {
        return (
          toChapterNumber(chapterA.number) - toChapterNumber(chapterB.number)
        );
      });

      const chapters: Plugin.ChapterItem[] = [];
      sortedChapters.forEach((chapter, index) => {
        const chapterId = chapter.id?.trim();
        if (!chapterId) {
          return;
        }

        chapters.push({
          name: buildChapterName(chapter, index + 1),
          path: slug
            ? `/content/${slug}/${chapterId}`
            : `${novelPath.replace(/\/+$/, '')}/${chapterId}`,
          releaseTime: chapter.createdAt
            ? dayjs(chapter.createdAt).format('LLL')
            : undefined,
          chapterNumber: toChapterNumber(chapter.number) || index + 1,
        });
      });

      novel.chapters = chapters;
    }

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = resolvePath(this.site, chapterPath);
    const result = await fetchApi(url);
    if (!result.ok) {
      throw new Error(`Could not reach ${url} (${result.status})`);
    }
    const body = await result.text();
    const loadedCheerio = parseHTML(body);

    const astroState = extractAstroState(loadedCheerio);
    const chapterData = astroState
      ? getAstroValueByKey<HexReaderChapter>(
          astroState,
          'reader-current-chapter',
        )
      : null;

    if (chapterData?.content) {
      if (
        typeof chapterData.content === 'string' &&
        chapterData.content.trim().length > 0
      ) {
        return chapterData.content;
      }

      if (typeof chapterData.content === 'object') {
        const renderedChapter = proseMirrorToHtml(
          chapterData.content as ProseMirrorInput,
        );
        if (renderedChapter.trim().length > 0) {
          return renderedChapter;
        }
      }
    }

    const contentMatch = body.match(
      /window\["current-chapter"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    );
    if (contentMatch?.[1]) {
      try {
        const oldChapterData = JSON.parse(contentMatch[1]) as {
          content?: string;
        };
        if (oldChapterData.content?.trim()) {
          return oldChapterData.content;
        }
      } catch {
        // Fallback to HTML selectors below.
      }
    }

    const contentSelectors = [
      '.chapter-content',
      '.reader-content',
      '.prose',
      '[class*="content"]',
      'article',
      'main',
    ];

    for (const selector of contentSelectors) {
      const content = loadedCheerio(selector).first().html();
      if (content && content.length > 100) {
        return content;
      }
    }

    return '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url = `${this.site}/content?page=${pageNo - 1}&size=30&query=${encodeURIComponent(searchTerm)}`;
    return this.fetchNovelItems(url);
  }

  private async fetchNovelItems(url: string): Promise<Plugin.NovelItem[]> {
    const result = await fetchApi(url);
    if (!result.ok) {
      throw new Error(`Could not reach ${url} (${result.status})`);
    }
    const body = await result.text();
    return extractNovelsFromListing(body);
  }

  filters = {
    sort: {
      label: 'Сортировка',
      value: 'viewsCount,desc',
      options: [
        { label: 'По популярности', value: 'viewsCount,desc' },
        { label: 'По дате добавления', value: 'createdAt,desc' },
        { label: 'По рейтингу', value: 'rating,desc' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new HexNovels();

function resolvePath(site: string, path: string): string {
  try {
    return new URL(path, site).toString();
  } catch {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${site}${normalizedPath}`;
  }
}

function sanitizeNovelTitle(value: string): string {
  return value
    .replace(/^Новелла\s+/i, '')
    .replace(/^Читать новеллу\s+/i, '')
    .replace(/\s+—\s+HexNovels$/i, '')
    .trim();
}

function extractNovelSlug(novelPath: string): string {
  const cleanPath = novelPath.split('?')[0].replace(/\/+$/, '');
  const match = cleanPath.match(/\/content\/([^/]+)/);
  if (match?.[1]) {
    return match[1];
  }
  return '';
}

function mapNovelStatus(status: unknown): string | undefined {
  if (typeof status !== 'string' || status.trim().length === 0) {
    return undefined;
  }
  return statusMap[status.toUpperCase()] || NovelStatus.Unknown;
}

function normalizeRating(rating: unknown): number | undefined {
  if (typeof rating !== 'number' || !Number.isFinite(rating)) {
    return undefined;
  }
  return rating > 5 ? rating / 2 : rating;
}

function pickLocalizedString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    const localized = value as Record<string, unknown>;
    const keys = ['ru', 'en', 'original', 'name'];
    for (const key of keys) {
      const text = localized[key];
      if (typeof text === 'string' && text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  return undefined;
}

function extractAuthor(
  relations: HexRelation[] | undefined,
): string | undefined {
  if (!relations?.length) {
    return undefined;
  }
  const authorRelation = relations.find(relation => relation.type === 'AUTHOR');
  const authorName = authorRelation?.publisher?.name;
  if (typeof authorName === 'string' && authorName.trim().length > 0) {
    return authorName.trim();
  }
  return undefined;
}

function extractGenres(labels: HexLabel[] | undefined): string | undefined {
  if (!labels?.length) {
    return undefined;
  }
  const names = labels
    .map(label => (typeof label?.name === 'string' ? label.name.trim() : ''))
    .filter(name => name.length > 0);
  if (!names.length) {
    return undefined;
  }
  return names.join(', ');
}

function toChapterNumber(value: unknown): number {
  const chapterNumber = Number(value);
  if (!Number.isFinite(chapterNumber)) {
    return 0;
  }
  return chapterNumber;
}

function buildChapterName(
  chapter: HexChapterData,
  fallbackNumber: number,
): string {
  const chapterNumber = toChapterNumber(chapter.number);
  const volumeNumber = toChapterNumber(chapter.volume);
  const chapterName =
    typeof chapter.name === 'string' ? chapter.name.trim() : '';

  const titleParts: string[] = [];
  if (volumeNumber > 0) {
    titleParts.push(`Том ${volumeNumber}`);
  }
  if (chapterNumber > 0) {
    titleParts.push(`Глава ${chapterNumber}`);
  }
  if (chapterName.length > 0) {
    titleParts.push(chapterName);
  }

  if (titleParts.length > 0) {
    return titleParts.join(' - ');
  }

  return `Глава ${fallbackNumber}`;
}

function extractNovelsFromListing(body: string): Plugin.NovelItem[] {
  const loadedCheerio = parseHTML(body);
  const novels: Plugin.NovelItem[] = [];
  const seenPaths = new Set<string>();

  loadedCheerio('a[href^="/content/"]').each((_, element) => {
    const $element = loadedCheerio(element);
    const href = $element.attr('href')?.trim();
    if (!href || seenPaths.has(href)) {
      return;
    }

    const slug = href.replace(/^\/content\//, '').split('?')[0];
    if (!slug || slug === 'top' || slug.includes('/')) {
      return;
    }

    const image = $element.find('img').first();
    const imageTitle = image.attr('alt')?.trim();
    const paragraphTitle = $element
      .find('p.text-sm.line-clamp-2')
      .first()
      .text()
      .trim();
    const fallbackTitle = $element.text().replace(/\s+/g, ' ').trim();
    const title = imageTitle || paragraphTitle || fallbackTitle;

    if (!title) {
      return;
    }

    const cover = image.attr('src')?.replace(/&amp;/g, '&') || defaultCover;
    seenPaths.add(href);
    novels.push({
      name: title,
      path: href,
      cover,
    });
  });

  return novels;
}

function extractAstroState(
  loadedCheerio: CheerioAPI,
): AstroStateValue[] | null {
  const rawState = loadedCheerio('#it-astro-state').html();
  if (!rawState) {
    return null;
  }

  try {
    const parsedState = JSON.parse(rawState) as AstroStateValue;
    if (Array.isArray(parsedState)) {
      return parsedState;
    }
  } catch {
    return null;
  }

  return null;
}

function getAstroValueByKey<T>(
  astroState: AstroStateValue[],
  key: string,
): T | null {
  const keyIndex = astroState.findIndex(item => item === key);
  if (keyIndex === -1 || keyIndex + 1 >= astroState.length) {
    return null;
  }

  const cache = new Map<number, unknown>();
  const visiting = new Set<number>();
  const resolvedValue = resolveAstroValue(
    astroState,
    astroState[keyIndex + 1],
    cache,
    visiting,
  );
  return resolvedValue as T;
}

function resolveAstroValue(
  astroState: AstroStateValue[],
  value: AstroStateValue,
  cache: Map<number, unknown>,
  visiting: Set<number>,
): unknown {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < astroState.length
  ) {
    if (cache.has(value)) {
      return cache.get(value);
    }
    if (visiting.has(value)) {
      return null;
    }

    visiting.add(value);
    const target = astroState[value];
    let resolved: unknown;

    if (Array.isArray(target)) {
      resolved = target.map(item =>
        resolveAstroValue(astroState, item, cache, visiting),
      );
    } else if (target && typeof target === 'object') {
      const objectResult: Record<string, unknown> = {};
      Object.entries(target).forEach(([entryKey, entryValue]) => {
        objectResult[entryKey] = resolveAstroValue(
          astroState,
          entryValue,
          cache,
          visiting,
        );
      });
      resolved = objectResult;
    } else {
      // Primitive values in devalue state are terminal values, not references.
      resolved = target;
    }

    visiting.delete(value);
    cache.set(value, resolved);
    return resolved;
  }

  if (Array.isArray(value)) {
    return value.map(item =>
      resolveAstroValue(astroState, item, cache, visiting),
    );
  }

  if (value && typeof value === 'object') {
    const objectResult: Record<string, unknown> = {};
    Object.entries(value).forEach(([entryKey, entryValue]) => {
      objectResult[entryKey] = resolveAstroValue(
        astroState,
        entryValue,
        cache,
        visiting,
      );
    });
    return objectResult;
  }

  return value;
}

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

type HexCatalogBook = {
  slug?: string;
  poster?: string;
  name?: string | Record<string, unknown>;
};

const statusMap: Record<string, string> = {
  ONGOING: NovelStatus.Ongoing,
  INPROGRESS: NovelStatus.Ongoing,
  DONE: NovelStatus.Completed,
  COMPLETED: NovelStatus.Completed,
  HIATUS: NovelStatus.OnHiatus,
  PAUSED: NovelStatus.OnHiatus,
  FROZEN: NovelStatus.OnHiatus,
  ANNOUNCE: NovelStatus.Unknown,
  CANCELLED: NovelStatus.Cancelled,
  DROPPED: NovelStatus.Cancelled,
};

const sortFieldOptions = [
  { label: 'Views', value: 'viewsCount' },
  { label: 'Likes', value: 'likesCount' },
  { label: 'Chapters', value: 'chaptersCount' },
  { label: 'Bookmarks', value: 'bookmarksCount' },
  { label: 'Rating', value: 'averageRating' },
  { label: 'Created Date', value: 'createdAt' },
] as const;

const sortOrderOptions = [
  { label: 'Descending', value: 'desc' },
  { label: 'Ascending', value: 'asc' },
] as const;

const countryOptions = [
  { label: 'Russia', value: 'RUSSIA' },
  { label: 'Japan', value: 'JAPAN' },
  { label: 'Korea', value: 'KOREA' },
  { label: 'China', value: 'CHINA' },
  { label: 'Other', value: 'OTHER' },
] as const;

const statusOptions = [
  { label: 'Ongoing', value: 'ONGOING' },
  { label: 'Done', value: 'DONE' },
  { label: 'Frozen', value: 'FROZEN' },
  { label: 'Announced', value: 'ANNOUNCE' },
] as const;

const contentStatusOptions = [
  { label: 'Safe', value: 'SAFE' },
  { label: 'Unsafe', value: 'UNSAFE' },
  { label: 'Erotic', value: 'EROTIC' },
  { label: 'Pornographic', value: 'PORNOGRAPHIC' },
] as const;

const formatOptions = [
  { label: 'Yonkoma', value: 'FOURTH_KOMA' },
  { label: 'Compilation', value: 'COMPILATION' },
  { label: 'Doujinshi', value: 'DOUJINSHI' },
  { label: 'Webtoon', value: 'WEBTOON' },
  { label: 'Colored', value: 'COLORED' },
  { label: 'Artbook', value: 'ARTBOOK' },
  { label: 'Single', value: 'SINGLE' },
  { label: 'Light Novel', value: 'LIGHT' },
  { label: 'Web Novel', value: 'WEB' },
] as const;

const genreOptions = [
  { label: 'Art', value: 'art' },
  { label: 'Action', value: 'action' },
  { label: 'Martial Arts', value: 'martial_arts' },
  { label: 'Vampires', value: 'vampires' },
  { label: 'Harem', value: 'harem' },
  { label: 'Gender Intrigue', value: 'gender_intriga' },
  { label: 'Detective', value: 'detective' },
  { label: 'Josei', value: 'josei' },
  { label: 'Drama', value: 'drama' },
  { label: 'Game', value: 'game' },
  { label: 'Isekai', value: 'isekai' },
  { label: 'Historical', value: 'historical' },
  { label: 'Cyberpunk', value: 'cyberpunk' },
  { label: 'Codomo', value: 'codomo' },
  { label: 'Comedy', value: 'comedy' },
  { label: 'Maho Shoujo', value: 'maho_shoujo' },
  { label: 'Mecha', value: 'mecha' },
  { label: 'Mystery', value: 'mystery' },
  { label: 'Sci-Fi', value: 'sci_fi' },
  { label: 'Omegaverse', value: 'omegavers' },
  { label: 'Slice of Life', value: 'natural' },
  { label: 'Post-Apocalypse', value: 'postapocalypse' },
  { label: 'Adventure', value: 'adventure' },
  { label: 'Psychological', value: 'psychological' },
  { label: 'Romance', value: 'romance' },
  { label: 'Samurai', value: 'samurai' },
  { label: 'Supernatural', value: 'supernatural' },
  { label: 'Shoujo', value: 'shoujo' },
  { label: 'Shounen', value: 'shounen' },
  { label: 'Sports', value: 'sports' },
  { label: 'Seinen', value: 'seinen' },
  { label: 'Tragedy', value: 'tragedy' },
  { label: 'Thriller', value: 'thriller' },
  { label: 'Horror', value: 'horror' },
  { label: 'Fantastic', value: 'fantastic' },
  { label: 'Fantasy', value: 'fantasy' },
  { label: 'School', value: 'school' },
  { label: 'Erotica', value: 'erotica' },
  { label: 'Ecchi', value: 'ecchi' },
] as const;

class HexNovels implements Plugin.PluginBase {
  id = 'hexnovels';
  name = 'HexNovels';
  icon = 'src/ru/hexnovels/icon.png';
  site = 'https://hexnovels.me';
  api = 'https://api.hexnovels.me';
  version = '1.0.2';

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const sortField = showLatestNovels
      ? 'createdAt'
      : filters?.sortField?.value || 'viewsCount';
    const sortOrder = showLatestNovels
      ? 'desc'
      : filters?.sortOrder?.value || 'desc';

    return this.fetchCatalogBooks(pageNo, sortField, sortOrder, '', filters);
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

      const sortedChapters = [...largestBranch].sort(compareChaptersForOrder);

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
          // Keep chapter number strictly monotonic in produced order.
          // Some titles reset chapter numbering for each volume, which can
          // otherwise cause host-side resorting like 1-1, 2-1, 1-2, 2-2...
          chapterNumber: index + 1,
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

    const legacyMatch = body.match(
      /window\["current-chapter"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    );
    if (legacyMatch?.[1]) {
      try {
        const legacyChapter = JSON.parse(legacyMatch[1]) as {
          content?: string;
        };
        if (legacyChapter.content?.trim()) {
          return legacyChapter.content;
        }
      } catch {
        // Keep fallback selectors below.
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
    return this.fetchCatalogBooks(
      pageNo,
      'viewsCount',
      'desc',
      searchTerm,
      undefined,
    );
  }

  private async fetchCatalogBooks(
    pageNo: number,
    sortField: string,
    sortOrder: string,
    searchTerm: string,
    filters: Plugin.PopularNovelsOptions<typeof this.filters>['filters'],
  ): Promise<Plugin.NovelItem[]> {
    const query = buildCatalogQueryParams(
      pageNo,
      sortField,
      sortOrder,
      searchTerm,
    );

    appendArrayFilters(query, 'country', filters?.countries?.value);
    appendArrayFilters(query, 'status', filters?.statuses?.value);
    appendArrayFilters(query, 'contentStatus', filters?.contentStatuses?.value);
    appendArrayFilters(query, 'formats', filters?.formats?.value);
    appendArrayFilters(query, 'labelsInclude', filters?.genres?.value?.include);
    appendArrayFilters(query, 'labelsExclude', filters?.genres?.value?.exclude);

    if (filters?.strictLabelEqual?.value) {
      query.set('strictLabelEqual', 'true');
    }

    setNumericFilter(
      query,
      'averageRatingMin',
      filters?.averageRatingMin?.value,
    );
    setNumericFilter(
      query,
      'averageRatingMax',
      filters?.averageRatingMax?.value,
    );
    setNumericFilter(
      query,
      'chaptersCountMin',
      filters?.chaptersCountMin?.value,
    );
    setNumericFilter(
      query,
      'chaptersCountMax',
      filters?.chaptersCountMax?.value,
    );
    setNumericFilter(query, 'yearMin', filters?.yearMin?.value);
    setNumericFilter(query, 'yearMax', filters?.yearMax?.value);

    const url = `${this.api}/v2/books?${query.toString()}`;
    const result = await fetchApi(url);
    if (!result.ok) {
      throw new Error(`Could not reach ${url} (${result.status})`);
    }

    const books = (await result.json()) as HexCatalogBook[];
    return books
      .filter(
        book => typeof book.slug === 'string' && book.slug.trim().length > 0,
      )
      .map(book => ({
        name: pickLocalizedString(book.name) || book.slug || 'Unknown',
        path: `/content/${book.slug}`,
        cover:
          typeof book.poster === 'string' && book.poster.trim().length > 0
            ? book.poster.trim()
            : defaultCover,
      }));
  }

  filters = {
    sortField: {
      label: 'Sort Field',
      value: 'viewsCount',
      options: sortFieldOptions,
      type: FilterTypes.Picker,
    },
    sortOrder: {
      label: 'Sort Order',
      value: 'desc',
      options: sortOrderOptions,
      type: FilterTypes.Picker,
    },
    countries: {
      label: 'Countries',
      value: [],
      options: countryOptions,
      type: FilterTypes.CheckboxGroup,
    },
    statuses: {
      label: 'Book Status',
      value: [],
      options: statusOptions,
      type: FilterTypes.CheckboxGroup,
    },
    contentStatuses: {
      label: 'Content Status',
      value: [],
      options: contentStatusOptions,
      type: FilterTypes.CheckboxGroup,
    },
    formats: {
      label: 'Formats',
      value: [],
      options: formatOptions,
      type: FilterTypes.CheckboxGroup,
    },
    genres: {
      label: 'Genres',
      value: { include: [], exclude: [] },
      options: genreOptions,
      type: FilterTypes.ExcludableCheckboxGroup,
    },
    strictLabelEqual: {
      label: 'Strict Included Genres',
      value: false,
      type: FilterTypes.Switch,
    },
    averageRatingMin: {
      label: 'Rating From',
      value: '',
      type: FilterTypes.TextInput,
    },
    averageRatingMax: {
      label: 'Rating To',
      value: '',
      type: FilterTypes.TextInput,
    },
    chaptersCountMin: {
      label: 'Chapters From',
      value: '',
      type: FilterTypes.TextInput,
    },
    chaptersCountMax: {
      label: 'Chapters To',
      value: '',
      type: FilterTypes.TextInput,
    },
    yearMin: {
      label: 'Year From',
      value: '',
      type: FilterTypes.TextInput,
    },
    yearMax: {
      label: 'Year To',
      value: '',
      type: FilterTypes.TextInput,
    },
  } satisfies Filters;
}

export default new HexNovels();

function resolvePath(site: string, path: string): string {
  try {
    return new URL(path, site).href;
  } catch {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${site}${normalizedPath}`;
  }
}

function sanitizeNovelTitle(value: string): string {
  return value.replace(/\s+[—-]\s+HexNovels$/i, '').trim();
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
    titleParts.push(`Volume ${volumeNumber}`);
  }
  if (chapterNumber > 0) {
    titleParts.push(`Chapter ${chapterNumber}`);
  }
  if (chapterName.length > 0) {
    titleParts.push(chapterName);
  }

  if (titleParts.length > 0) {
    return titleParts.join(' - ');
  }

  return `Chapter ${fallbackNumber}`;
}

function compareChaptersForOrder(
  chapterA: HexChapterData,
  chapterB: HexChapterData,
): number {
  const volumeDiff =
    toChapterNumber(chapterA.volume) - toChapterNumber(chapterB.volume);
  if (volumeDiff !== 0) {
    return volumeDiff;
  }

  const chapterDiff =
    toChapterNumber(chapterA.number) - toChapterNumber(chapterB.number);
  if (chapterDiff !== 0) {
    return chapterDiff;
  }

  const dateDiff = compareIsoDates(chapterA.createdAt, chapterB.createdAt);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  return 0;
}

function compareIsoDates(
  left: string | undefined,
  right: string | undefined,
): number {
  if (!left || !right) {
    return 0;
  }

  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return 0;
  }

  return leftTime - rightTime;
}

function buildCatalogQueryParams(
  pageNo: number,
  sortField: string,
  sortOrder: string,
  searchTerm: string,
): URLSearchParams {
  const query = new URLSearchParams();
  query.set('size', '30');
  query.set('page', `${Math.max(pageNo - 1, 0)}`);
  query.set('sort', `${sortField},${sortOrder}`);

  const normalizedSearch = searchTerm.trim();
  if (normalizedSearch.length > 0) {
    query.set('search', normalizedSearch);
  }

  return query;
}

function appendArrayFilters(
  query: URLSearchParams,
  key: string,
  values: string[] | undefined,
): void {
  if (!values?.length) {
    return;
  }

  values
    .map(value => value.trim())
    .filter(value => value.length > 0)
    .forEach(value => query.append(key, value));
}

function setNumericFilter(
  query: URLSearchParams,
  key: string,
  rawValue: string | undefined,
): void {
  if (!rawValue) {
    return;
  }

  const normalized = rawValue.trim();
  if (!/^-?\d+$/.test(normalized)) {
    return;
  }

  query.set(key, normalized);
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

import { Plugin } from '@/types/plugin';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { fetchApi } from '@libs/fetch';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { load as parseHTML } from 'cheerio';
import dayjs from 'dayjs';

class HexNovels implements Plugin.PluginBase {
  id = 'hexnovels';
  name = 'HexNovels';
  icon = 'src/en/hexnovels/icon.png';
  site = 'https://hexnovels.me';
  version = '1.0.0';

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

    const body = await fetchApi(url).then(res => res.text());
    const loadedCheerio = parseHTML(body);
    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('a[href^="/content/"]').each((_, element) => {
      const $el = loadedCheerio(element);
      const href = $el.attr('href');
      const title = $el.find('h3.font-semibold.line-clamp-2').text().trim();
      const imgSrc = $el.find('img').attr('src');

      if (href && title) {
        novels.push({
          name: title,
          path: href,
          cover: imgSrc || defaultCover,
        });
      }
    });

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = this.site + novelPath;
    const body = await fetchApi(url).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('meta[property="og:title"]').attr('content') || '',
      summary: loadedCheerio('meta[name="description"]').attr('content'),
      cover: loadedCheerio('meta[property="og:image"]').attr('content'),
    };

    if (!novel.cover) {
      novel.cover = defaultCover;
    }

    // Extract book data from embedded JSON
    const bookMatch = body.match(
      /window\["current-book"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    );
    const chaptersMatch = body.match(
      /window\["current-book-chapters"\]\s*=\s*(\[[\s\S]*?\]);?\s*<\/script>/,
    );

    let bookData: BookData | null = null;
    let chaptersData: ChapterData[] | null = null;

    if (bookMatch && bookMatch[1]) {
      try {
        bookData = JSON.parse(bookMatch[1]) as BookData;
      } catch {
        bookData = null;
      }
    }

    if (chaptersMatch && chaptersMatch[1]) {
      try {
        chaptersData = JSON.parse(chaptersMatch[1]) as ChapterData[];
      } catch {
        chaptersData = null;
      }
    }

    if (bookData) {
      novel.name = bookData.name || novel.name;
      novel.summary = bookData.description || novel.summary;

      if (bookData.covers && bookData.covers.length > 0) {
        const cover = bookData.covers[0];
        novel.cover = `https://gstatic.inuko.me/book/${bookData.id}/cover/${cover.id}.jpeg?width=320&type=webp`;
      }

      if (bookData.status) {
        novel.status =
          bookData.status === 'ONGOING'
            ? NovelStatus.Ongoing
            : NovelStatus.Completed;
      }

      if (bookData.author) {
        novel.author = bookData.author;
      }

      if (bookData.labels && bookData.labels.length > 0) {
        novel.genres = bookData.labels.map(label => label.name).join(', ');
      }

      if (bookData.rating) {
        novel.rating = bookData.rating / 2;
      }
    }

    // Parse chapters
    if (chaptersData && chaptersData.length > 0) {
      const chapters: Plugin.ChapterItem[] = [];
      const bookSlug = novelPath.split('/').pop() || '';

      // Group chapters by branch (translation team)
      const chaptersByBranch = new Map<string, ChapterData[]>();
      chaptersData.forEach(chapter => {
        const branchId = chapter.branchId || 'default';
        if (!chaptersByBranch.has(branchId)) {
          chaptersByBranch.set(branchId, []);
        }
        chaptersByBranch.get(branchId)?.push(chapter);
      });

      // Use the branch with most chapters
      let largestBranch: ChapterData[] = [];
      chaptersByBranch.forEach(branchChapters => {
        if (branchChapters.length > largestBranch.length) {
          largestBranch = branchChapters;
        }
      });

      largestBranch.forEach((chapter, index) => {
        chapters.push({
          name: chapter.name || `Глава ${chapter.number}`,
          path: `/read/${bookSlug}/${chapter.id}`,
          releaseTime: chapter.createdAt
            ? dayjs(chapter.createdAt).format('LLL')
            : undefined,
          chapterNumber: index + 1,
        });
      });

      novel.chapters = chapters.reverse();
    }

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.site + chapterPath;
    const body = await fetchApi(url).then(res => res.text());

    // Try to extract chapter content from embedded JSON
    const contentMatch = body.match(
      /window\["current-chapter"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    );

    if (contentMatch && contentMatch[1]) {
      try {
        const chapterData = JSON.parse(contentMatch[1]) as { content?: string };
        if (chapterData.content) {
          return chapterData.content;
        }
      } catch {
        // Fall through to HTML parsing
      }
    }

    // Fallback to HTML parsing
    const loadedCheerio = parseHTML(body);

    // Try common content selectors
    const contentSelectors = [
      '.chapter-content',
      '.reader-content',
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
    // HexNovels uses query parameter for search
    const url = `${this.site}/content?page=${pageNo - 1}&size=30&query=${encodeURIComponent(searchTerm)}`;

    const body = await fetchApi(url).then(res => res.text());
    const loadedCheerio = parseHTML(body);
    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('a[href^="/content/"]').each((_, element) => {
      const $el = loadedCheerio(element);
      const href = $el.attr('href');
      const title = $el.find('h3.font-semibold.line-clamp-2').text().trim();
      const imgSrc = $el.find('img').attr('src');

      if (href && title) {
        novels.push({
          name: title,
          path: href,
          cover: imgSrc || defaultCover,
        });
      }
    });

    return novels;
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

// Type definitions for embedded JSON data
interface BookData {
  id: string;
  name: string;
  description?: string;
  status?: string;
  author?: string;
  rating?: number;
  covers?: Array<{ id: string }>;
  labels?: Array<{ name: string }>;
}

interface ChapterData {
  id: string;
  name?: string;
  number: number;
  volume?: number;
  branchId?: string;
  createdAt?: string;
}

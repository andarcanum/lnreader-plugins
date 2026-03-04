import { Parser } from 'htmlparser2';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters, FilterTypes } from '@libs/filterInputs';

type RanobesOptions = {
  lang?: string;
  path: string;
};

export type RanobesMetadata = {
  id: string;
  sourceSite: string;
  sourceName: string;
  options?: RanobesOptions;
};

class RanobesPlugin implements Plugin.PluginBase {
  id: string;
  name: string;
  icon: string;
  site: string;
  version: string;
  options: RanobesOptions;
  filters: Filters;

  constructor(metadata: RanobesMetadata) {
    this.id = metadata.id;
    this.name = metadata.sourceName;
    this.icon = 'multisrc/ranobes/ranobes/icon.png';
    this.site = metadata.sourceSite;
    this.version = '2.1.0';
    this.options = metadata.options as RanobesOptions;
    this.filters = this.createFilters();
  }

  async safeFecth(url: string, init: any = {}): Promise<string> {
    const r = await fetchApi(url, init);
    if (!r.ok)
      throw new Error(
        'Could not reach site (' + r.status + ') try to open in webview.',
      );
    const data = await r.text();
    const title = data.match(/<title>(.*?)<\/title>/)?.[1]?.trim();

    if (
      title &&
      (title == 'Bot Verification' ||
        title == 'You are being redirected...' ||
        title == 'Un instant...' ||
        title == 'Just a moment...' ||
        title == 'Redirecting...')
    )
      throw new Error('Captcha error, please open in webview');

    return data;
  }

  parseNovels(html: string) {
    const novels: Plugin.NovelItem[] = [];
    let tempNovel = {} as Plugin.NovelItem;
    tempNovel.name = '';
    const baseUrl = this.site;
    let isParsingNovel = false;
    let isTitleTag = false;
    let isNovelName = false;
    const parser = new Parser({
      onopentag(name, attribs) {
        if (attribs['class']?.includes('short-cont')) {
          isParsingNovel = true;
        }
        if (isParsingNovel) {
          if (name === 'h2' && attribs['class']?.includes('title')) {
            isTitleTag = true;
          }
          if (isTitleTag && name === 'a') {
            tempNovel.path = attribs['href'].slice(baseUrl.length);
            isNovelName = true;
          }
          if (name === 'figure') {
            tempNovel.cover = attribs['style'].replace(
              /.*url\((.*?)\)./g,
              '$1',
            );
          }
          if (tempNovel.path && tempNovel.cover) {
            novels.push(tempNovel);
            tempNovel = {} as Plugin.NovelItem;
            tempNovel.name = '';
          }
        }
      },
      ontext(data) {
        if (isNovelName) {
          tempNovel.name += data;
        }
      },
      onclosetag(name) {
        if (name === 'h2') {
          isNovelName = false;
          isTitleTag = false;
        }
        if (name === 'figure') {
          isParsingNovel = false;
        }
      },
    });
    parser.write(html);
    parser.end();
    return novels;
  }

  parseChapters(data: { chapters: ChapterEntry[] }) {
    const chapter: Plugin.ChapterItem[] = [];
    data.chapters.map((item: ChapterEntry) => {
      chapter.push({
        name: item.title,
        releaseTime: new Date(item.date).toISOString(),
        path: item.link.slice(this.site.length),
      });
    });
    return chapter.reverse();
  }

  parseDate = (date: string) => {
    const now = new Date();
    if (!date) return now.toISOString();
    if (this.id === 'ranobes-ru') {
      if (date.includes(' в ')) return date.replace(' в ', ' г., ');

      const [when, time] = date.split(', ');
      if (!time) return now.toISOString();
      const [h, m] = time.split(':');

      switch (when) {
        case 'Сегодня':
          now.setHours(parseInt(h, 10));
          now.setMinutes(parseInt(m, 10));
          break;
        case 'Вчера':
          now.setDate(now.getDate() - 1);
          now.setHours(parseInt(h, 10));
          now.setMinutes(parseInt(m, 10));
          break;
        default:
          return now.toISOString();
      }
    } else {
      const [num, xz, ago] = date.split(' ');
      if (ago !== 'ago') return now.toISOString();

      switch (xz) {
        case 'minutes':
          now.setMinutes(parseInt(num, 10));
          break;
        case 'hour':
        case 'hours':
          now.setHours(parseInt(num, 10));
          break;
        case 'day':
        case 'days':
          now.setDate(now.getDate() - parseInt(num, 10));
          break;
        case 'month':
        case 'months':
          now.setMonth(now.getMonth() - parseInt(num, 10));
          break;
        case 'year':
        case 'years':
          now.setFullYear(now.getFullYear() - parseInt(num, 10));
          break;
        default:
          return now.toISOString();
      }
    }
    return now.toISOString();
  };

  private getFilterConfig() {
    if (this.id === 'ranobes-ru') {
      return {
        includeLanguageKey: 'b.country',
        excludeLanguageKey: 'v.country',
        translationStatusOptions: [
          { label: 'Any', value: '' },
          {
            label: 'Active',
            value: '\u0410\u043a\u0442\u0438\u0432\u0435\u043d',
          },
          {
            label: 'Completed',
            value: '\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e',
          },
          {
            label: 'Waiting for chapters',
            value:
              '\u0412 \u043e\u0436\u0438\u0434\u0430\u043d\u0438\u0439 \u0433\u043b\u0430\u0432',
          },
          {
            label: 'Not active',
            value: '\u041d\u0435 \u0430\u043a\u0442\u0438\u0432\u0435\u043d',
          },
        ],
        originalStatusOptions: [
          { label: 'Any', value: '' },
          {
            label: 'Ongoing',
            value: '\u0412 \u043f\u0440\u043e\u0446\u0435\u0441\u0441\u0435',
          },
          {
            label: 'Completed',
            value: '\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e',
          },
          {
            label: 'Hiatus',
            value:
              '\u041e\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d',
          },
          { label: 'Dropped', value: '\u0423\u0434\u0430\u043b\u0435\u043d' },
        ],
        languageOptions: [
          {
            label: 'Chinese',
            value: '\u041a\u0438\u0442\u0430\u0439\u0441\u043a\u0438\u0439',
          },
          {
            label: 'Korean',
            value: '\u041a\u043e\u0440\u0435\u0439\u0441\u043a\u0438\u0439',
          },
          {
            label: 'Russian',
            value: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439',
          },
          {
            label: 'Japanese',
            value: '\u042f\u043f\u043e\u043d\u0441\u043a\u0438\u0439',
          },
          {
            label: 'English',
            value:
              '\u0410\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439',
          },
        ],
      };
    }

    return {
      includeLanguageKey: 'b.languages',
      excludeLanguageKey: 'v.languages',
      translationStatusOptions: [
        { label: 'Any', value: '' },
        { label: 'Active', value: 'Active' },
        { label: 'Completed', value: 'Completed' },
        { label: 'Unknown', value: 'Unknown' },
        { label: 'Break', value: 'Break' },
      ],
      originalStatusOptions: [
        { label: 'Any', value: '' },
        { label: 'Ongoing', value: 'Ongoing' },
        { label: 'Completed', value: 'Completed' },
        { label: 'Hiatus', value: 'Hiatus' },
        { label: 'Dropped', value: 'Dropped' },
      ],
      languageOptions: [
        { label: 'Chinese', value: 'Chinese' },
        { label: 'Korean', value: 'Korean' },
        { label: 'English', value: 'English' },
        { label: 'Japanese', value: 'Japanese' },
      ],
    };
  }

  private createFilters(): Filters {
    const config = this.getFilterConfig();
    return {
      sort: {
        label: 'Sort by',
        value: '',
        options: [
          { label: 'Default', value: '' },
          { label: 'Latest updates', value: 'date' },
          { label: 'Rating', value: 'rating' },
          { label: 'Title', value: 'title' },
          { label: 'Comments', value: 'comm_num' },
          { label: 'Views', value: 'news_read' },
          { label: 'Chapters', value: 'd.chap-num' },
          { label: 'Year', value: 'd.year' },
        ],
        type: FilterTypes.Picker,
      },
      order: {
        label: 'Order',
        value: 'desc',
        options: [
          { label: 'Descending', value: 'desc' },
          { label: 'Ascending', value: 'asc' },
        ],
        type: FilterTypes.Picker,
      },
      includeGenres: {
        label: 'Genres (include, comma-separated)',
        value: '',
        type: FilterTypes.TextInput,
      },
      excludeGenres: {
        label: 'Genres (exclude, comma-separated)',
        value: '',
        type: FilterTypes.TextInput,
      },
      translationStatus: {
        label: 'Translation status',
        value: '',
        options: config.translationStatusOptions,
        type: FilterTypes.Picker,
      },
      originalStatus: {
        label: 'Original status',
        value: '',
        options: config.originalStatusOptions,
        type: FilterTypes.Picker,
      },
      languages: {
        label: 'Languages',
        value: {
          include: [],
          exclude: [],
        },
        options: config.languageOptions,
        type: FilterTypes.ExcludableCheckboxGroup,
      },
      minChapters: {
        label: 'Min chapters',
        value: '',
        type: FilterTypes.TextInput,
      },
      maxChapters: {
        label: 'Max chapters',
        value: '',
        type: FilterTypes.TextInput,
      },
    } satisfies Filters;
  }

  async popularNovels(
    page: number,
    {
      filters,
      showLatestNovels,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const selectedSort = (filters?.sort?.value as string) || '';
    const selectedOrder = (filters?.order?.value as string) || 'desc';
    const selectedIncludeGenres =
      (filters?.includeGenres?.value as string) || '';
    const selectedExcludeGenres =
      (filters?.excludeGenres?.value as string) || '';
    const selectedTranslationStatus =
      (filters?.translationStatus?.value as string) || '';
    const selectedOriginalStatus =
      (filters?.originalStatus?.value as string) || '';
    const selectedMinChapters = (filters?.minChapters?.value as string) || '';
    const selectedMaxChapters = (filters?.maxChapters?.value as string) || '';
    const selectedLanguages = (filters?.languages?.value as
      | { include?: string[]; exclude?: string[] }
      | undefined) || { include: [], exclude: [] };

    const config = this.getFilterConfig();
    const sortValue = showLatestNovels ? 'date' : selectedSort;
    const hasUserFilters =
      !!selectedIncludeGenres.trim() ||
      !!selectedExcludeGenres.trim() ||
      !!selectedTranslationStatus ||
      !!selectedOriginalStatus ||
      !!selectedMinChapters.trim() ||
      !!selectedMaxChapters.trim() ||
      (selectedLanguages.include?.length || 0) > 0 ||
      (selectedLanguages.exclude?.length || 0) > 0;
    const shouldUseFilterPath = hasUserFilters || !!sortValue;
    const pathSegments: string[] = [];
    const addSegment = (name: string, value: string) => {
      const sanitized = value.trim();
      if (!sanitized) return;
      pathSegments.push(
        `${encodeURIComponent(name)}=${encodeURIComponent(sanitized)}`,
      );
    };

    if (shouldUseFilterPath) {
      if (selectedLanguages.include?.length) {
        addSegment(
          config.includeLanguageKey,
          selectedLanguages.include.join(','),
        );
      }
      if (selectedLanguages.exclude?.length) {
        addSegment(
          config.excludeLanguageKey,
          selectedLanguages.exclude.join(','),
        );
      }
      addSegment('n.genre', selectedIncludeGenres);
      addSegment('v.genre', selectedExcludeGenres);
      addSegment('status-trs', selectedTranslationStatus);
      addSegment('status-end', selectedOriginalStatus);
      addSegment('f.chap-num', selectedMinChapters);
      addSegment('t.chap-num', selectedMaxChapters);
      addSegment('cat', '1');

      if (sortValue) {
        addSegment('sort', sortValue);
        addSegment('order', selectedOrder);
      }
    }

    let link = `${this.site}/${this.options.path}/page/${page}/`;
    if (pathSegments.length > 0) {
      link = `${this.site}/f/${pathSegments.join('/')}/`;
      if (page > 1) link += `page/${page}/`;
    }

    const body = await this.safeFecth(link);
    return this.parseNovels(body);
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel & { totalPages: number }> {
    const baseUrl = this.site;
    const html = await this.safeFecth(baseUrl + novelPath);
    const novel: Plugin.SourceNovel & { totalPages: number } = {
      path: novelPath,
      name: '',
      summary: '',
      chapters: [],
      totalPages: 1,
    };
    let isCover = false;
    let isAuthor = false;
    let isSummary = false;
    let isStatus = false;
    let isStatusText = false;
    let isGenres = false;
    let isGenresText = false;
    let isMaxChapters = false;
    let isChapter = false;
    let isChapterTitle = false;
    let isChapterDate = false;
    const genreArray: string[] = [];
    const chapters: Plugin.ChapterItem[] = [];
    let tempchapter: Plugin.ChapterItem = {};
    let maxChapters = 0;
    const fixDate = this.parseDate;
    const parser = new Parser({
      onopentag(name, attribs) {
        if (attribs['class'] === 'poster') {
          isCover = true;
        }
        if (isCover && name === 'img') {
          novel.name = attribs['alt'];
          novel.cover = baseUrl + attribs['src'];
        }
        if (
          (name === 'div' &&
            attribs['class'] === 'moreless cont-text showcont-h') ||
          (attribs['class'] === 'cont-text showcont-h' &&
            attribs['itemprop'] === 'description')
        ) {
          isSummary = true;
        }
        if (
          name === 'li' &&
          attribs['title'] &&
          (attribs['title'].includes('Original status') ||
            attribs['title'].includes('Статус оригинала'))
        ) {
          isStatus = true;
        }
        if (name === 'a' && attribs['rel'] === 'chapter') {
          isChapter = true;
          tempchapter.path = attribs['href'].replace(baseUrl, '');
        }
        if (
          isChapter &&
          name === 'span' &&
          attribs['class'] === 'title ellipses'
        ) {
          isChapterTitle = true;
        }
        if (isChapter && name === 'span' && attribs['class'] === 'grey') {
          isChapterDate = true;
        }
        if (
          name === 'li' &&
          (attribs['title'] ==
            'Glossary + illustrations + division of chapters, etc.' ||
            attribs['title'] ===
              'Глоссарий + иллюстраций + разделение глав и т.д.')
        ) {
          isMaxChapters = true;
        }
      },
      onopentagname(name) {
        if (isSummary && name === 'br') {
          novel.summary += '\n';
        }
        if (isStatus && name === 'a') {
          isStatusText = true;
        }
        if (isGenres && name === 'a') {
          isGenresText = true;
        }
      },
      onattribute(name, value) {
        if (name === 'itemprop' && value === 'creator') {
          isAuthor = true;
        }
        if (name === 'id' && value === 'mc-fs-genre') {
          isGenres = true;
        }
      },
      ontext(data) {
        if (isAuthor) {
          novel.author = data;
        }
        if (isSummary) {
          novel.summary += data.trim();
        }
        if (isStatusText) {
          novel.status =
            data === 'Ongoing' || data == 'В процессе'
              ? NovelStatus.Ongoing
              : NovelStatus.Completed;
        }
        if (isGenresText) {
          genreArray.push(data);
        }
        if (isMaxChapters) {
          const isNumber = data.replace(/\D/g, '');
          if (isNumber) {
            maxChapters = parseInt(isNumber, 10);
          }
        }
        if (isChapter) {
          if (isChapterTitle) tempchapter.name = data.trim();
          if (isChapterDate) tempchapter.releaseTime = fixDate(data.trim());
        }
      },
      onclosetag(name) {
        if (name === 'a') {
          isCover = false;
          isAuthor = false;
          isStatusText = false;
          isGenresText = false;
          isStatus = false;
        }
        if (name === 'div') {
          isSummary = false;
          isGenres = false;
        }
        if (name === 'li') {
          isMaxChapters = false;
        }
        if (name === 'a') {
          isChapter = false;
          if (tempchapter.name) {
            chapters.push({ ...tempchapter, page: '1' });
            tempchapter = {};
          }
        }
        if (name === 'span') {
          if (isChapterTitle) isChapterTitle = false;
          if (isChapterDate) isChapterDate = false;
        }
      },
    });
    parser.write(html);
    parser.end();
    novel.genres = genreArray.join(', ');
    novel.totalPages = Math.ceil((maxChapters || 1) / 25);
    novel.chapters = chapters;

    if (novel.chapters[0].path) {
      novel.latestChapter = novel.chapters[0];
    }

    return novel;
  }

  async parsePage(novelPath: string, page: string): Promise<Plugin.SourcePage> {
    const pagePath =
      this.id == 'ranobes'
        ? novelPath.split('-')[0]
        : '/' + novelPath.split('-').slice(1).join('-').split('.')[0];
    const firstUrl =
      this.site + '/chapters' + pagePath.replace(this.options.path + '/', '');
    const pageBody = await this.safeFecth(firstUrl + '/page/' + page);

    const baseUrl = this.site;
    let isScript = false;
    let isChapter = false;
    let isChapterInfo = false;
    let isChapterDate = false;

    let chapters: Plugin.ChapterItem[] = [];
    let tempchapter: Plugin.ChapterItem = {};
    const fixDate = this.parseDate;

    let dataJson: {
      pages_count: string;
      chapters: ChapterEntry[];
    } = { pages_count: '', chapters: [] };

    const parser = new Parser({
      onopentag(name, attribs) {
        if (name === 'div' && attribs['class'] === 'cat_block cat_line') {
          isChapter = true;
        }
        if (isChapter && name === 'a' && attribs['title'] && attribs['href']) {
          tempchapter.name = attribs['title'];
          tempchapter.path = attribs['href'].replace(baseUrl, '');
        }
        if (name === 'span' && attribs['class'] === 'grey small') {
          isChapterInfo = true;
        }
        if (name === 'small' && isChapterInfo) {
          isChapterDate = true;
        }
      },
      ontext(data) {
        if (isChapterDate) tempchapter.releaseTime = fixDate(data.trim());
        if (isScript) {
          if (data.includes('window.__DATA__ =')) {
            dataJson = JSON.parse(data.replace('window.__DATA__ =', ''));
          }
        }
      },
      onclosetag(name) {
        if (name === 'a' && tempchapter.name) {
          chapters.push(tempchapter);
          tempchapter = {};
        }
        if (name === 'div') {
          isChapter = false;
        }
        if (name === 'span') {
          isChapterInfo = false;
        }
        if (name === 'small') {
          isChapterDate = false;
        }
        if (name === 'main') {
          isScript = true;
        }
        if (name === 'script') {
          isScript = false;
        }
      },
    });
    parser.write(pageBody);
    parser.end();

    if (dataJson.chapters?.length) {
      chapters = this.parseChapters(dataJson);
    }

    return {
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const html = await this.safeFecth(this.site + chapterPath);

    const indexA = html.indexOf('<div class="text" id="arrticle">');
    const indexB = html.indexOf('<div class="category grey ellipses">', indexA);

    const chapterText = html.substring(indexA, indexB);
    return chapterText;
  }

  async searchNovels(
    searchTerm: string,
    page: number,
  ): Promise<Plugin.NovelItem[]> {
    let html;
    if (this.id === 'ranobes-ru') {
      html = await this.safeFecth(this.site + '/index.php?do=search', {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: this.site + '/',
        },
        method: 'POST',
        body: new URLSearchParams({
          do: 'search',
          subaction: 'search',
          search_start: page.toString(),
          story: searchTerm,
        }).toString(),
      });
    } else {
      const link = `${this.site}/search/${searchTerm}/page/${page}`;
      html = await this.safeFecth(link);
    }
    return this.parseNovels(html);
  }
}

type ChapterEntry = {
  id: number;
  title: string;
  date: string;
  link: string;
};

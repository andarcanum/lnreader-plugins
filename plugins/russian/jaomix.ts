import { Plugin } from '@/types/plugin';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { fetchApi } from '@libs/fetch';
import { NovelStatus } from '@libs/novelStatus';
import { load as parseHTML } from 'cheerio';
import dayjs from 'dayjs';

class Jaomix implements Plugin.PluginBase {
  id = 'jaomix.ru';
  name = 'Jaomix';
  site = 'https://jaomix.ru';
  version = '1.0.5';
  icon = 'src/ru/jaomix/icon.png';

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let url = this.site + '/?searchrn';

    if (filters?.lang?.value?.length) {
      url += filters.lang.value
        .map((lang, idx) => `&lang[${idx}]=${lang}`)
        .join('');
    }

    if (filters?.genre?.value?.include?.length) {
      url += filters.genre.value.include
        .map((genre, idx) => `&genre[${idx}]=${genre}`)
        .join('');
    }

    if (filters?.genre?.value?.exclude?.length) {
      url += filters.genre.value.exclude
        .map((genre, idx) => `&delgenre[${idx}]=del ${genre}`)
        .join('');
    }

    url += '&sortcountchapt=' + (filters?.sortcountchapt?.value || '1');
    url += '&sortdaycreate=' + (filters?.sortdaycreate?.value || '1');
    url +=
      '&sortby=' +
      (showLatestNovels ? 'upd' : filters?.sortby?.value || 'topweek');
    url += '&gpage=' + pageNo;

    const body = await fetchApi(url).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    const novels: Plugin.NovelItem[] = [];
    loadedCheerio('div[class="block-home"] > div[class="one"]').each(
      (index, element) => {
        const name = loadedCheerio(element)
          .find('div[class="img-home"] > a')
          .attr('title');
        const cover = loadedCheerio(element)
          .find('div[class="img-home"] > a > img')
          .attr('src')
          ?.replace('-150x150', '');
        const url = loadedCheerio(element)
          .find('div[class="img-home"] > a')
          .attr('href');

        if (!name || !url) return;

        novels.push({ name, cover, path: url.replace(this.site, '') });
      },
    );

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novelUrl = this.site + novelPath;
    const novelResponse = await fetchApi(novelUrl);
    const body = await novelResponse.text();
    const loadedCheerio = parseHTML(body);
    const normalizedNovelPath = this.normalizePath(novelPath);
    const chapterPagesCount = loadedCheerio('select.sel-toc option').length;

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('div[class="desc-book"] > h1').text().trim(),
      cover: loadedCheerio('div[class="img-book"] > img').attr('src'),
      summary: loadedCheerio('div[id="desc-tab"]').text().trim(),
    };

    loadedCheerio('#info-book > p').each(function () {
      const text = loadedCheerio(this).text().replace(/,/g, '').split(' ');
      if (text[0] === 'Автор:') {
        novel.author = text.splice(1).join(' ');
      } else if (text[0] === 'Жанры:') {
        novel.genres = text.splice(1).join(',');
      } else if (text[0] === 'Статус:') {
        novel.status = text.includes('продолжается')
          ? NovelStatus.Ongoing
          : NovelStatus.Completed;
      }
    });

    const chapterFragments = await this.getChapterFragments(
      loadedCheerio,
      novelUrl,
      novelResponse,
    );
    const chapterItems: Omit<Plugin.ChapterItem, 'chapterNumber'>[] = [];
    const chapterPaths = new Set<string>();

    for (const fragment of chapterFragments) {
      const loadedFragment = parseHTML(fragment);
      loadedFragment('div.title').each((_, element) => {
        const name =
          loadedFragment(element).find('a').attr('title') ||
          loadedFragment(element).find('h2').text().trim();
        const url = loadedFragment(element).find('a').attr('href');
        if (!name || !url) return;

        const path = this.toPath(url);
        if (!path.startsWith(normalizedNovelPath)) return;
        if (chapterPaths.has(path)) return;

        chapterPaths.add(path);
        const releaseDate = loadedFragment(element).find('time').text().trim();
        chapterItems.push({
          name: name.trim(),
          path,
          releaseTime: this.parseDate(releaseDate),
        });
      });
    }

    let orderedChapterItems = chapterItems.reverse();
    if (chapterPagesCount > 1 && orderedChapterItems.length <= 50) {
      const chaptersFromNavigation = await this.collectChaptersByNavigation(
        loadedCheerio,
        normalizedNovelPath,
      );
      if (chaptersFromNavigation.length > orderedChapterItems.length) {
        orderedChapterItems = chaptersFromNavigation;
      }
    }

    novel.chapters = orderedChapterItems.map((chapter, chapterIndex) => ({
      ...chapter,
      chapterNumber: chapterIndex + 1,
    }));
    return novel;
  }

  normalizePath(path: string): string {
    return path.endsWith('/') ? path : path + '/';
  }

  toPath(url: string): string {
    try {
      return new URL(url, this.site).pathname;
    } catch (_) {
      return url.replace(this.site, '');
    }
  }

  async collectChaptersByNavigation(
    loadedCheerio: ReturnType<typeof parseHTML>,
    novelPath: string,
  ): Promise<Omit<Plugin.ChapterItem, 'chapterNumber'>[]> {
    const firstChapterUrl =
      loadedCheerio('.link-last-first-chapter .ins-first a').attr('href') ||
      loadedCheerio('.ins-first a').attr('href');
    if (!firstChapterUrl) return [];

    const chapters: Omit<Plugin.ChapterItem, 'chapterNumber'>[] = [];
    const visitedPaths = new Set<string>();
    let currentChapterUrl = firstChapterUrl;

    for (let safetyCounter = 0; safetyCounter < 1500; safetyCounter++) {
      try {
        const chapterResponse = await fetchApi(currentChapterUrl);
        if (!chapterResponse.ok) break;

        const chapterBody = await chapterResponse.text();
        const chapterCheerio = parseHTML(chapterBody);
        const canonicalUrl =
          chapterCheerio('link[rel="canonical"]').attr('href') ||
          chapterCheerio('meta[property="og:url"]').attr('content') ||
          currentChapterUrl;
        const chapterPath = this.toPath(canonicalUrl);
        if (
          !chapterPath.startsWith(novelPath) ||
          visitedPaths.has(chapterPath)
        ) {
          break;
        }

        visitedPaths.add(chapterPath);
        const chapterName = chapterCheerio('h1').first().text().trim();
        const releaseDate = chapterCheerio('time').first().text().trim();
        chapters.push({
          name: chapterName || `Chapter ${chapters.length + 1}`,
          path: chapterPath,
          releaseTime: this.parseDate(releaseDate),
        });

        const nextChapterUrl = chapterCheerio('.next a').attr('href');
        if (!nextChapterUrl) break;

        const nextPath = this.toPath(nextChapterUrl);
        if (!nextPath.startsWith(novelPath)) break;
        currentChapterUrl = new URL(nextChapterUrl, this.site).toString();
      } catch (_) {
        break;
      }
    }

    return chapters;
  }

  async getChapterFragments(
    loadedCheerio: ReturnType<typeof parseHTML>,
    novelUrl: string,
    novelResponse: Response,
  ): Promise<string[]> {
    const chapterFragments: string[] = [];
    const baseChapterHtml = loadedCheerio('.block-toc-out').html();
    if (baseChapterHtml) chapterFragments.push(baseChapterHtml);

    const chapterPages = loadedCheerio('select.sel-toc option')
      .map((_, element) => loadedCheerio(element).attr('value') || '')
      .get()
      .filter(Boolean);
    if (!chapterPages.length)
      return chapterFragments.length
        ? chapterFragments
        : [loadedCheerio.html()];

    const cookieHeader = novelResponse.headers
      .get('set-cookie')
      ?.match(/^\s*([^;]+)/)?.[1];
    for (const page of new Set(chapterPages)) {
      if (baseChapterHtml && page === '1') continue;

      try {
        const pageBody =
          'action=loadpagenavchapstt&page=' + encodeURIComponent(page);
        const headers: Record<string, string> = {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: novelUrl,
          'x-referer': novelUrl,
        };
        if (cookieHeader) headers.Cookie = cookieHeader;

        const chapterHtml = await this.loadAjaxChapterPage(
          pageBody,
          novelUrl,
          headers,
        );
        if (!chapterHtml) continue;
        chapterFragments.push(chapterHtml);
      } catch (_) {
        continue;
      }
    }

    return chapterFragments.length ? chapterFragments : [loadedCheerio.html()];
  }

  async loadAjaxChapterPage(
    pageBody: string,
    novelUrl: string,
    headers: Record<string, string>,
  ): Promise<string> {
    const ajaxUrl = this.site + '/wp-admin/admin-ajax.php';
    const hasChapterMarkup = (html: string) =>
      html.includes('class="title"') || html.includes("class='title'");

    const chapterPageResponse = await fetchApi(ajaxUrl, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: pageBody,
    });
    if (chapterPageResponse.ok) {
      const chapterHtml = await chapterPageResponse.text();
      if (hasChapterMarkup(chapterHtml)) return chapterHtml;
    }

    const fallbackHeaders: Record<string, string> = { ...headers };
    delete fallbackHeaders.Referer;
    const fallbackResponse = await fetchApi(ajaxUrl, {
      method: 'POST',
      headers: fallbackHeaders,
      credentials: 'include',
      referrer: novelUrl,
      referrerPolicy: 'unsafe-url',
      body: pageBody,
    });
    if (!fallbackResponse.ok) return '';

    const fallbackHtml = await fallbackResponse.text();
    return hasChapterMarkup(fallbackHtml) ? fallbackHtml : '';
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const body = await fetchApi(this.site + chapterPath).then(res =>
      res.text(),
    );
    const loadedCheerio = parseHTML(body);

    loadedCheerio('div.adblock-service, div[class="adblock-service"]').remove();

    const contentSelectors = [
      'div.entry-content',
      'article .entry-content',
      'div[class*="entry-content"]',
      'article',
    ];
    let chapterText = '';
    let hasCaptchaGate = false;
    for (const selector of contentSelectors) {
      const contentNode = loadedCheerio(selector).first().clone();
      if (!contentNode.length) continue;
      hasCaptchaGate =
        hasCaptchaGate ||
        contentNode.find('.but-captcha').length > 0 ||
        /загрузки полной главы/i.test(contentNode.text());
      contentNode
        .find(
          'script, style, iframe, noscript, .but-captcha, .block-capth, [class^="block-capth"], [class*=" block-capth"]',
        )
        .remove();
      chapterText = contentNode.html() || '';
      if (chapterText.trim()) break;
    }

    if (hasCaptchaGate) {
      const chapterFromMirror = await this.loadChapterFromMirror(chapterPath);
      if (chapterFromMirror) return chapterFromMirror;
    }

    return chapterText.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');
  }

  async loadChapterFromMirror(chapterPath: string): Promise<string> {
    const chapterUrl = new URL(chapterPath, this.site).toString();
    const mirrorUrl =
      'https://r.jina.ai/http://r.jina.ai/' +
      chapterUrl.replace(/^https?:\/\//, 'http://');

    try {
      const mirrorResponse = await fetchApi(mirrorUrl);
      if (!mirrorResponse.ok) return '';

      const mirrorBody = await mirrorResponse.text();
      const markdownMarker = 'Markdown Content:';
      const markdownMarkerIndex = mirrorBody.indexOf(markdownMarker);
      if (markdownMarkerIndex === -1) return '';

      const markdownChapterText = mirrorBody
        .slice(markdownMarkerIndex + markdownMarker.length)
        .trim();
      if (!markdownChapterText) return '';

      return this.markdownTextToHtml(markdownChapterText);
    } catch (_) {
      return '';
    }
  }

  markdownTextToHtml(markdownText: string): string {
    return markdownText
      .replace(/\r/g, '')
      .split(/\n{2,}/)
      .map(paragraph => paragraph.trim())
      .filter(Boolean)
      .map(
        paragraph =>
          '<p>' + this.escapeHtml(paragraph).replace(/\n/g, '<br>') + '</p>',
      )
      .join('');
  }

  escapeHtml(rawText: string): string {
    return rawText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number | undefined = 1,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      this.site +
      '/?searchrn=' +
      searchTerm +
      '&but=Поиск по названию&sortby=upd&gpage=' +
      pageNo;
    const body = await fetchApi(url).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    const novels: Plugin.NovelItem[] = [];
    loadedCheerio('div[class="block-home"] > div[class="one"]').each(
      (index, element) => {
        const name = loadedCheerio(element)
          .find('div[class="img-home"] > a')
          .attr('title');
        const cover = loadedCheerio(element)
          .find('div[class="img-home"] > a > img')
          .attr('src')
          ?.replace('-150x150', '');
        const url = loadedCheerio(element)
          .find('div[class="img-home"] > a')
          .attr('href');

        if (!name || !url) return;

        novels.push({ name, cover, path: url.replace(this.site, '') });
      },
    );

    return novels;
  }

  parseDate = (dateString: string | undefined = '') => {
    const months: Record<string, number> = {
      Янв: 1,
      Фев: 2,
      Мар: 3,
      Апр: 4,
      Май: 5,
      Июн: 6,
      Июл: 7,
      Авг: 8,
      Сен: 9,
      Окт: 10,
      Ноя: 11,
      Дек: 12,
    };

    const [time, day, month, year] = dateString.split(' ');
    if (time && day && months[month] && year) {
      return dayjs(year + '-' + months[month] + '-' + day + ' ' + time).format(
        'LLL',
      );
    }

    return dateString || null;
  };

  filters = {
    sortby: {
      label: 'Сортировка:',
      value: 'topweek',
      options: [
        { label: 'Топ недели', value: 'topweek' },
        { label: 'По алфавиту', value: 'alphabet' },
        { label: 'По дате обновления', value: 'upd' },
        { label: 'По дате создания', value: 'new' },
        { label: 'По просмотрам', value: 'count' },
        { label: 'Топ года', value: 'topyear' },
        { label: 'Топ дня', value: 'topday' },
        { label: 'Топ за все время', value: 'alltime' },
        { label: 'Топ месяца', value: 'topmonth' },
      ],
      type: FilterTypes.Picker,
    },
    sortdaycreate: {
      label: 'Дата добавления:',
      value: '1',
      options: [
        { label: 'Дата добавления', value: '1' },
        { label: 'От 120 до 180 дней', value: '1218' },
        { label: 'От 180 до 365 дней', value: '1836' },
        { label: 'От 30 до 60 дней', value: '3060' },
        { label: 'От 365 дней', value: '365' },
        { label: 'От 60 до 90 дней', value: '6090' },
        { label: 'От 90 до 120 дней', value: '9012' },
        { label: 'Послед. 30 дней', value: '30' },
      ],
      type: FilterTypes.Picker,
    },
    sortcountchapt: {
      label: 'Количество глав:',
      value: '1',
      options: [
        { label: 'Любое кол-во глав', value: '1' },
        { label: 'До 500', value: '500' },
        { label: 'От 1000 до 2000', value: '1020' },
        { label: 'От 2000 до 3000', value: '2030' },
        { label: 'От 3000 до 4000', value: '3040' },
        { label: 'От 4000', value: '400' },
        { label: 'От 500 до 1000', value: '510' },
      ],
      type: FilterTypes.Picker,
    },
    genre: {
      label: 'Жанры:',
      value: { include: [], exclude: [] },
      options: [
        { label: 'Боевые Искусства', value: 'Боевые Искусства' },
        { label: 'Виртуальный Мир', value: 'Виртуальный Мир' },
        { label: 'Гарем', value: 'Гарем' },
        { label: 'Детектив', value: 'Детектив' },
        { label: 'Драма', value: 'Драма' },
        { label: 'Игра', value: 'Игра' },
        { label: 'Истории из жизни', value: 'Истории из жизни' },
        { label: 'Исторический', value: 'Исторический' },
        { label: 'История', value: 'История' },
        { label: 'Исэкай', value: 'Исэкай' },
        { label: 'Комедия', value: 'Комедия' },
        { label: 'Меха', value: 'Меха' },
        { label: 'Мистика', value: 'Мистика' },
        { label: 'Научная Фантастика', value: 'Научная Фантастика' },
        { label: 'Повседневность', value: 'Повседневность' },
        { label: 'Постапокалипсис', value: 'Постапокалипсис' },
        { label: 'Приключения', value: 'Приключения' },
        { label: 'Психология', value: 'Психология' },
        { label: 'Романтика', value: 'Романтика' },
        { label: 'Сверхъестественное', value: 'Сверхъестественное' },
        { label: 'Сёнэн', value: 'Сёнэн' },
        { label: 'Спорт', value: 'Спорт' },
        { label: 'Сэйнэн', value: 'Сэйнэн' },
        { label: 'Сюаньхуа', value: 'Сюаньхуа' },
        { label: 'Трагедия', value: 'Трагедия' },
        { label: 'Триллер', value: 'Триллер' },
        { label: 'Фантастика', value: 'Фантастика' },
        { label: 'Фэнтези', value: 'Фэнтези' },
        { label: 'Хоррор', value: 'Хоррор' },
        { label: 'Школьная жизнь', value: 'Школьная жизнь' },
        { label: 'Шоунен', value: 'Шоунен' },
        { label: 'Экшн', value: 'Экшн' },
        { label: 'Этти', value: 'Этти' },
        { label: 'Adult', value: 'Adult' },
        { label: 'Ecchi', value: 'Ecchi' },
        { label: 'Josei', value: 'Josei' },
        { label: 'Mature', value: 'Mature' },
        { label: 'Shoujo', value: 'Shoujo' },
        { label: 'Wuxia', value: 'Wuxia' },
        { label: 'Xianxia', value: 'Xianxia' },
        { label: 'Xuanhuan', value: 'Xuanhuan' },
      ],
      type: FilterTypes.ExcludableCheckboxGroup,
    },
    lang: {
      label: 'Выбрать языки:',
      value: [],
      options: [
        { label: 'Английский', value: 'Английский' },
        { label: 'Китайский', value: 'Китайский' },
        { label: 'Корейский', value: 'Корейский' },
        { label: 'Японский', value: 'Японский' },
      ],
      type: FilterTypes.CheckboxGroup,
    },
  } satisfies Filters;
}

export default new Jaomix();

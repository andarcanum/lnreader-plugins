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
  version = '1.0.7';
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
    const resolvedNovelPath = this.normalizePath(
      this.toPath(novelResponse.url || novelUrl),
    );

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
      novelResponse.url || novelUrl,
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
        if (!path.startsWith(resolvedNovelPath)) return;
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

    novel.chapters = chapterItems.reverse().map((chapter, chapterIndex) => ({
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

  sleep(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
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
    const pagesToLoad = [...new Set(chapterPages)].slice(0, 40);
    let sequentialFailures = 0;

    for (const page of pagesToLoad) {
      if (baseChapterHtml && page === '1') continue;

      try {
        const pageBody =
          'action=loadpagenavchapstt&page=' + encodeURIComponent(page);
        const headers: Record<string, string> = {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: '*/*',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: novelUrl,
          'x-referer': novelUrl,
        };
        headers.Cookie = cookieHeader
          ? cookieHeader + '; i18n_redirected=ru'
          : 'i18n_redirected=ru';

        const chapterHtml = await this.loadAjaxChapterPage(pageBody, headers);
        if (!chapterHtml) {
          sequentialFailures += 1;
          if (sequentialFailures >= 3) break;
          await this.sleep(300);
          continue;
        }

        sequentialFailures = 0;
        chapterFragments.push(chapterHtml);
        await this.sleep(120);
      } catch (_) {
        sequentialFailures += 1;
        if (sequentialFailures >= 3) break;
        await this.sleep(300);
      }
    }

    return chapterFragments.length ? chapterFragments : [loadedCheerio.html()];
  }

  async loadAjaxChapterPage(
    pageBody: string,
    headers: Record<string, string>,
  ): Promise<string> {
    const chapterPageResponse = await fetchApi(
      this.site + '/wp-admin/admin-ajax.php',
      {
        method: 'POST',
        headers,
        credentials: 'include',
        body: pageBody,
      },
    );
    if (!chapterPageResponse.ok) return '';

    const chapterHtml = await chapterPageResponse.text();
    const hasChapterMarkup =
      chapterHtml.includes('class="title"') ||
      chapterHtml.includes("class='title'");
    return hasChapterMarkup ? chapterHtml : '';
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
        hasCaptchaGate || contentNode.find('.but-captcha').length > 0;
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
    const monthIndexByName: Record<string, number> = {
      ['\u044f\u043d\u0432']: 1,
      ['\u044f\u043d\u0432\u0430\u0440\u044f']: 1,
      ['\u0444\u0435\u0432']: 2,
      ['\u0444\u0435\u0432\u0440\u0430\u043b\u044f']: 2,
      ['\u043c\u0430\u0440']: 3,
      ['\u043c\u0430\u0440\u0442\u0430']: 3,
      ['\u0430\u043f\u0440']: 4,
      ['\u0430\u043f\u0440\u0435\u043b\u044f']: 4,
      ['\u043c\u0430\u0439']: 5,
      ['\u043c\u0430\u044f']: 5,
      ['\u0438\u044e\u043d']: 6,
      ['\u0438\u044e\u043d\u044f']: 6,
      ['\u0438\u044e\u043b']: 7,
      ['\u0438\u044e\u043b\u044f']: 7,
      ['\u0430\u0432\u0433']: 8,
      ['\u0430\u0432\u0433\u0443\u0441\u0442\u0430']: 8,
      ['\u0441\u0435\u043d']: 9,
      ['\u0441\u0435\u043d\u0442\u044f\u0431\u0440\u044f']: 9,
      ['\u043e\u043a\u0442']: 10,
      ['\u043e\u043a\u0442\u044f\u0431\u0440\u044f']: 10,
      ['\u043d\u043e\u044f']: 11,
      ['\u043d\u043e\u044f\u0431\u0440\u044f']: 11,
      ['\u0434\u0435\u043a']: 12,
      ['\u0434\u0435\u043a\u0430\u0431\u0440\u044f']: 12,
    };

    const match = dateString
      .trim()
      .match(/^(\d{1,2}:\d{2})\s+(\d{1,2})\s+([^\s]+)\s+(\d{4})$/);
    if (!match) return null;

    const [, time, day, rawMonth, year] = match;
    const monthName = rawMonth.replace('.', '').toLowerCase();
    const monthIndex = monthIndexByName[monthName];
    if (!monthIndex) return null;

    const [hour, minute] = time.split(':').map(value => parseInt(value, 10));
    const parsedDate = dayjs(
      new Date(
        parseInt(year, 10),
        monthIndex - 1,
        parseInt(day, 10),
        hour,
        minute,
      ),
    );

    return parsedDate.isValid() ? parsedDate.format('YYYY-MM-DD HH:mm') : null;
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

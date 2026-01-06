import { fetchApi } from '@libs/fetch';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { load as parseHTML } from 'cheerio';
import dayjs from 'dayjs';
//Test 3
export type RulateMetadata = {
  id: string;
  sourceSite: string;
  sourceName: string;
  filters?: Filters;
  versionIncrements: number;
};

class RulatePlugin implements Plugin.PluginBase {
  id: string;
  name: string;
  icon: string;
  site: string;
  version: string;
  filters?: Filters | undefined;

  constructor(metadata: RulateMetadata) {
    this.id = metadata.id;
    this.name = metadata.sourceName;
    this.icon = `multisrc/rulate/${metadata.id.toLowerCase()}/icon.png`;
    // Гарантируем, что site не undefined и без слеша на конце.
    this.site = (metadata.sourceSite || 'https://erolate.com').replace(/\/+$/, '');
    this.version = '1.0.' + (2 + metadata.versionIncrements);
    this.filters = metadata.filters;
  }

  // Вспомогательный геттер для заголовков.
  get headers() {
    return {
      Referer: (this.site || 'https://erolate.com').replace(/\/+$/, ''),
    };
  }

  // Вспомогательный геттер для безопасного базового URL (на всякий случай!).
  get baseUrl() {
    return (this.site || 'https://erolate.com').replace(/\/+$/, '');
  }

  async popularNovels(
    pageNo: number,
    { filters, showLatestNovels }: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    const novels: Plugin.NovelItem[] = [];
    let url = this.baseUrl + '/search?t=';
    
    url += '&cat=' + (filters?.cat?.value || '0');
    url += '&s_lang=' + (filters?.s_lang?.value || '0');
    url += '&t_lang=' + (filters?.t_lang?.value || '0');
    url += '&type=' + (filters?.type?.value || '0');
    url += '&sort=' + (showLatestNovels ? '4' : filters?.sort?.value || '6');
    url += '&atmosphere=' + (filters?.atmosphere?.value || '0');
    url += '&adult=' + (filters?.adult?.value || '0');

    Object.entries(filters || {}).forEach(([type, { value }]) => {
      if (value instanceof Array && value.length) {
        url +=
          '&' +
          value
            .map(val => (type == 'extra' ? val + '=1' : type + '[]=' + val))
            .join('&');
      }
    });

    url += '&Book_page=' + pageNo;

    const body = await fetchApi(url, { headers: this.headers }).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    loadedCheerio(
      'ul[class="search-results"] > li:not([class="ad_type_catalog"])',
    ).each((index, element) => {
      const name = loadedCheerio(element).find('p > a').text().trim();
      const path = loadedCheerio(element).find('p > a').attr('href');
      
      const coverAttr = loadedCheerio(element).find('img').attr('src');
      const cover = coverAttr ? this.baseUrl + coverAttr : '';

      if (!name || !path) return;

      novels.push({ name, cover, path });
    });

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const baseUrl = (this.site || 'https://erolate.com').replace(/\/+$/, '');
    let result = await fetchApi(baseUrl + novelPath, { headers: this.headers });

    if (result.url.includes('mature?path=')) {
      const formData = new FormData();
      formData.append('path', novelPath);
      formData.append('ok', 'Да');

      result = await fetchApi(result.url, {
        method: 'POST',
        body: formData,
        headers: this.headers,
      });
    }
    const body = await result.text();
    const loadedCheerio = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('.span8 > h1, .book__title').text().trim(),
    };
    
    // Чистим имя от лишнего
    if (novel.name?.includes?.('[')) {
      novel.name = novel.name.split('[')[0].trim();
    }
    
    // --- ИСПРАВЛЕНИЕ ОБЛОЖКИ ---
    // Добавил больше вариантов селекторов
    const coverAttr = loadedCheerio(
        '.images .slick-slide img, ' +  // Слайдер
        '.images img, ' +               // Просто картинка в блоке
        '.book__cover > img, ' +        // Альтернативный дизайн
        'div[class="images"] > div img' // Старый селектор
    ).attr('src');

    if (coverAttr) {
        novel.cover = baseUrl + coverAttr;
    }

    novel.summary = loadedCheerio(
      '#Info > div:nth-child(4) > p:nth-child(1), .book__description',
    ).text().trim();

    const genres: string[] = [];
    loadedCheerio('div.span5 > p').each(function () {
      const label = loadedCheerio(this).find('strong').text();
      const value = loadedCheerio(this).find('em > a, em').text().trim(); // Упростил поиск значения

      if (label.includes('Автор:')) {
          novel.author = value;
      } else if (label.includes('Выпуск:')) {
          novel.status = value === 'продолжается' ? NovelStatus.Ongoing : NovelStatus.Completed;
      } else if (label.includes('Тэги:') || label.includes('Жанры:')) {
          loadedCheerio(this).find('em > a').each((_, el) => {
              genres.push(loadedCheerio(el).text());
          });
      }
    });

    if (genres.length) {
      novel.genres = genres.reverse().join(',');
    }

    // --- ИСПРАВЛЕНИЕ ГЛАВ ---
    const chapters: Plugin.ChapterItem[] = [];
    
    // Сначала ищем таблицу (как на Rulate / EroLate)
    const tableRows = loadedCheerio('table > tbody > tr.chapter_row');

    if (tableRows.length > 0) {
        // Если нашли таблицу — парсим её
        tableRows.each((chapterIndex, element) => {
          const chapterName = loadedCheerio(element).find('td[class="t"] > a').text().trim();
          const releaseDate = loadedCheerio(element).find('td > span').attr('title')?.trim();
          const chapterUrl = loadedCheerio(element).find('td[class="t"] > a').attr('href');
          const isDisabled = loadedCheerio(element).find('td > span[class="disabled"]').length > 0;

          if (!isDisabled && chapterUrl) {
            chapters.push({
              name: chapterName,
              path: chapterUrl,
              releaseTime: releaseDate ? this.parseDate(releaseDate) : undefined,
              chapterNumber: chapterIndex + 1,
            });
          }
        });
    } else {
        // Если таблицы нет — пробуем искать ссылки (резервный вариант)
        loadedCheerio('a.chapter').each((chapterIndex, element) => {
            const chapterName = loadedCheerio(element).find('.chapter-title, div:nth-child(1) > span:nth-child(2)').text().trim();
            const chapterUrl = loadedCheerio(element).attr('href');
            const isPaid = loadedCheerio(element).find('span[data-can-buy="true"]').length > 0;

            if (!isPaid && chapterUrl) {
              chapters.push({
                name: chapterName || `Chapter ${chapterIndex + 1}`,
                path: chapterUrl,
                chapterNumber: chapterIndex + 1,
              });
            }
        });
    }

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'Referer': this.baseUrl + chapterPath
    };

    // Исправлено: один запрос, использующий безопасный baseUrl
    let result = await fetchApi(this.baseUrl + chapterPath, { headers });

    if (result.url.includes('mature?path=')) {
      const formData = new FormData();
      formData.append('path', chapterPath);
      formData.append('ok', 'Да');

      result = await fetchApi(result.url, {
        method: 'POST',
        body: formData,
        headers, // Используем те же headers
      });
    }

    const body = await result.text();
    const loadedCheerio = parseHTML(body);

    const chapterText = loadedCheerio(
      '.content-text, #read-text, .entry-content, .b-chapter-text',
    ).html();
    
    return chapterText || '';
  }

  async searchNovels(searchTerm: string): Promise<Plugin.NovelItem[]> {
    const novels: Plugin.NovelItem[] = [];
    const url =
      this.baseUrl + '/search/autocomplete?query=' + encodeURIComponent(searchTerm);

    const result: response[] = await fetchApi(url, { headers: this.headers }).then(res => res.json());

    result.forEach(novel => {
      const name = novel.title_one + ' / ' + novel.title_two;
      if (!novel.url) return;
      
      const cover = novel.img ? this.baseUrl + novel.img : '';

      novels.push({
        name,
        cover,
        path: novel.url,
      });
    });

    return novels;
  }

  parseDate = (dateString: string | undefined = '') => {
    const months: Record<string, number> = {
      'янв.': 1,
      'февр.': 2,
      'мар.': 3,
      'апр.': 4,
      мая: 5,
      'июн.': 6,
      'июл.': 7,
      'авг.': 8,
      'сент.': 9,
      'окт.': 10,
      'нояб.': 11,
      'дек.': 12,
    };
    const [day, month, year, , time] = dateString.split(' ');
    if (day && months[month] && year && time) {
      return dayjs(year + '-' + months[month] + '-' + day + ' ' + time).format(
        'LLL',
      );
    }
    return dateString || null;
  };
}

type response = {
  id: number;
  title_one: string;
  title_two: string;
  url: string;
  img: string;
};

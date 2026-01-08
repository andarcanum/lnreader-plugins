import { load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { storage } from '@libs/storage';

class WebnovelRating implements Plugin.PluginBase {
  id = 'webnovelrating';
  name = 'Webnovel Rating';
  version = '1.0.0';
  icon = 'src/en/webnovel/icon.png';
  site = 'https://www.webnovel.com';
  headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  imageRequestInit?: Plugin.ImageRequestInit | undefined = {
    headers: {
      referrer: this.site,
    },
  };
  hideLocked = storage.get('hideLocked');
  pluginSettings = {
    hideLocked: {
      value: '',
      label: 'Hide locked chapters',
      type: 'Switch',
    },
  };

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];

    const rankingType = filters?.ranking_type?.value || 'power_rank';
    const timePeriod = filters?.time_period?.value || 'monthly';

    let url: string;

    if (rankingType === 'power_rank' || rankingType === 'trending_rank') {
      url = `${this.site}/ranking/novel/${timePeriod}/${rankingType}`;
    } else {
      url = `${this.site}/ranking/novel/${rankingType}`;
    }

    const result = await fetchApi(url, {
      headers: this.headers,
    });
    const body = await result.text();
    const loadedCheerio = parseHTML(body);

    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('.j_rank_wrapper section').each((_, ele) => {
      const novelLink = loadedCheerio(ele).find('a[href^="/book/"]').first();
      const novelPath = novelLink.attr('href');
      if (!novelPath) return;

      const novelName =
        loadedCheerio(ele).find('h3 a.c_l').attr('title') ||
        loadedCheerio(ele).find('h3 a.c_l').text().trim() ||
        'No Title Found';

      const imgElement = loadedCheerio(ele).find('.g_thumb img');
      let novelCover =
        imgElement.attr('src') || imgElement.attr('data-original') || '';
      if (novelCover && !novelCover.startsWith('http')) {
        novelCover = 'https:' + novelCover;
      }

      novels.push({
        name: novelName,
        cover: novelCover,
        path: novelPath,
      });
    });

    return novels;
  }

  async parseChapters(novelPath: string): Promise<Plugin.ChapterItem[]> {
    const url = this.site + novelPath + '/catalog';
    const result = await fetchApi(url, {
      headers: this.headers,
    });
    const body = await result.text();

    const loadedCheerio = parseHTML(body);

    const chapters: Plugin.ChapterItem[] = [];

    loadedCheerio('.volume-item').each((_, ele_v) => {
      const originalVolumeName = loadedCheerio(ele_v).first().text().trim();
      const volumeNameMatch = originalVolumeName.match(/Volume\s(\d+)/);
      const volumeName = volumeNameMatch
        ? `Volume ${volumeNameMatch[1]}`
        : 'Unknown Volume';

      loadedCheerio(ele_v)
        .find('li')
        .each((_, ele_c) => {
          const chapterName =
            `${volumeName}: ` +
            (loadedCheerio(ele_c).find('a').attr('title')?.trim() ||
              'No Title Found');
          const chapterPath = loadedCheerio(ele_c).find('a').attr('href');
          const locked = loadedCheerio(ele_c).find('svg').length;

          if (chapterPath && !(locked && this.hideLocked)) {
            chapters.push({
              name: locked ? `${chapterName} 🔒` : chapterName,
              path: chapterPath,
            });
          }
        });
    });

    return chapters;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = this.site + novelPath;
    const result = await fetchApi(url, {
      headers: this.headers,
    });
    const body = await result.text();

    const loadedCheerio = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('.g_thumb > img').attr('alt') || 'No Title Found',
      cover: 'https:' + loadedCheerio('.g_thumb > img').attr('src'),
      genres: loadedCheerio('.det-hd-detail > .det-hd-tag').attr('title') || '',
      summary:
        loadedCheerio('.j_synopsis > p')
          .find('br')
          .replaceWith('\n')
          .end()
          .text()
          .trim() || 'No Summary Found',
      author:
        loadedCheerio('.det-info .c_s')
          .filter((_, ele) => {
            return loadedCheerio(ele).text().trim() === 'Author:';
          })
          .next()
          .text()
          .trim() || 'No Author Found',
      status:
        loadedCheerio('.det-hd-detail svg')
          .filter((_, ele) => {
            return loadedCheerio(ele).attr('title') === 'Status';
          })
          .next()
          .text()
          .trim() || 'Unknown Status',
      chapters: await this.parseChapters(novelPath),
    };

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.site + chapterPath;
    const result = await fetchApi(url, {
      headers: this.headers,
    });
    const body = await result.text();

    const loadedCheerio = parseHTML(body);

    const bloatElements = ['.para-comment'];
    bloatElements.forEach(tag => loadedCheerio(tag).remove());

    return (
      loadedCheerio('.cha-tit').html()! + loadedCheerio('.cha-words').html()!
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    searchTerm = searchTerm.replace(/\s+/g, '+');

    const url = `${this.site}/search?keywords=${encodeURIComponent(searchTerm)}&pageIndex=${pageNo}`;
    const result = await fetchApi(url, {
      headers: this.headers,
    });
    const body = await result.text();

    const loadedCheerio = parseHTML(body);

    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('.j_list_container li').each((_, ele) => {
      const novelName =
        loadedCheerio(ele).find('.g_thumb').attr('title') || 'No Title Found';
      const novelCover = loadedCheerio(ele).find('.g_thumb > img').attr('src');
      const novelPath = loadedCheerio(ele).find('.g_thumb').attr('href');

      if (novelPath) {
        novels.push({
          name: novelName,
          cover: novelCover ? 'https:' + novelCover : '',
          path: novelPath,
        });
      }
    });

    return novels;
  }

  filters = {
    ranking_type: {
      label: 'Ranking Type',
      value: 'power_rank',
      options: [
        { label: 'Power', value: 'power_rank' },
        { label: 'Trending', value: 'trending_rank' },
        { label: 'Collect', value: 'collect_rank' },
        { label: 'Popular', value: 'popular_rank' },
        { label: 'Update', value: 'update_rank' },
        { label: 'Active', value: 'active_rank' },
        { label: 'Fandom', value: 'fandom_rank' },
      ],
      type: FilterTypes.Picker,
    },
    time_period: {
      label: 'Time Period (Power/Trending only)',
      value: 'monthly',
      options: [
        { label: 'Monthly', value: 'monthly' },
        { label: 'All-time', value: 'all_time' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new WebnovelRating();

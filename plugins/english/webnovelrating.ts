import { load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { storage } from '@libs/storage';

type RankingResponse = {
  code: number;
  data: {
    bookItems: {
      rankNo: number;
      bookId: string;
      bookName: string;
      description: string;
      categoryName: string;
      authorName: string;
      coverUpdateTime: number;
    }[];
  };
};

class WebnovelRating implements Plugin.PluginBase {
  id = 'webnovelrating';
  name = 'Webnovel Rating';
  version = '1.0.1';
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

  private csrfToken: string | null = null;

  private async getCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;

    const result = await fetchApi(this.site, {
      headers: this.headers,
    });
    const cookies = result.headers.get('set-cookie') || '';
    const match = cookies.match(/_csrfToken=([^;]+)/);
    if (match) {
      this.csrfToken = match[1];
      return this.csrfToken;
    }

    const body = await result.text();
    const tokenMatch = body.match(/_csrfToken['"]\s*:\s*['"]([^'"]+)['"]/);
    if (tokenMatch) {
      this.csrfToken = tokenMatch[1];
      return this.csrfToken;
    }

    return '';
  }

  private getTimeTypeValue(timePeriod: string): string {
    const timeTypeMap: Record<string, string> = {
      monthly: '4',
      season: '4',
      bi_annual: '3',
      annual: '3',
      all_time: '1',
    };
    return timeTypeMap[timePeriod] || '3';
  }

  private getRankName(rankingType: string): string {
    const rankNameMap: Record<string, string> = {
      power_rank: 'Power',
      best_sellers: 'Trending',
      collection_rank: 'Collect',
      popular_rank: 'Popular',
      update_rank: 'Update',
      engagement_rank: 'Active',
      fandom_rank: 'Fandom',
    };
    return rankNameMap[rankingType] || 'Power';
  }

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const rankingType = filters?.ranking_type?.value || 'power_rank';
    const timePeriod = filters?.time_period?.value || 'bi_annual';
    const sourceType = filters?.source_type?.value || '0';
    const sex = filters?.sex?.value || '1';
    const signStatus = filters?.sign_status?.value || '0';

    if (pageNo === 1) {
      let url: string;
      if (rankingType === 'power_rank' || rankingType === 'best_sellers') {
        url = `${this.site}/ranking/novel/${timePeriod}/${rankingType}`;
      } else {
        url = `${this.site}/ranking/novel/all_time/${rankingType}`;
      }

      const result = await fetchApi(url, {
        headers: this.headers,
      });
      const body = await result.text();

      const tokenMatch = body.match(/_csrfToken=([^;'"&]+)/);
      if (tokenMatch) {
        this.csrfToken = decodeURIComponent(tokenMatch[1]);
      }

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

    if (!this.csrfToken) {
      await this.getCsrfToken();
    }

    const timeType = this.getTimeTypeValue(timePeriod);
    const rankName = this.getRankName(rankingType);

    const params = new URLSearchParams({
      _csrfToken: this.csrfToken || '',
      pageIndex: pageNo.toString(),
      rankId: rankingType,
      listType: '3',
      type: '1',
      rankName: rankName,
      timeType: timeType,
      sourceType: sourceType,
      sex: sex,
      signStatus: signStatus,
    });

    const apiUrl = `${this.site}/go/pcm/category/getRankList?${params.toString()}`;

    const result = await fetchApi(apiUrl, {
      headers: {
        ...this.headers,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    const data: RankingResponse = await result.json();

    if (data.code !== 0 || !data.data?.bookItems) {
      return [];
    }

    return data.data.bookItems.map(book => ({
      name: book.bookName,
      cover: `https://book-pic.webnovel.com/bookcover/${book.bookId}?imageMogr2/thumbnail/150`,
      path: `/book/${book.bookName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${book.bookId}`,
    }));
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
        { label: 'Trending', value: 'best_sellers' },
        { label: 'Collect', value: 'collection_rank' },
        { label: 'Popular', value: 'popular_rank' },
        { label: 'Update', value: 'update_rank' },
        { label: 'Active', value: 'engagement_rank' },
        { label: 'Fandom', value: 'fandom_rank' },
      ],
      type: FilterTypes.Picker,
    },
    time_period: {
      label: 'Time Period (Power/Trending only)',
      value: 'bi_annual',
      options: [
        { label: 'Monthly (≤30 Days)', value: 'monthly' },
        { label: 'Season (31-90 Days)', value: 'season' },
        { label: 'Bi-annual (91-180 Days)', value: 'bi_annual' },
        { label: 'Annual (181-365 Days)', value: 'annual' },
        { label: 'All-time (>365 Days)', value: 'all_time' },
      ],
      type: FilterTypes.Picker,
    },
    source_type: {
      label: 'Content Type',
      value: '0',
      options: [
        { label: 'All', value: '0' },
        { label: 'Translate', value: '1' },
        { label: 'Original', value: '2' },
      ],
      type: FilterTypes.Picker,
    },
    sex: {
      label: 'Reading Preference',
      value: '1',
      options: [
        { label: 'Male', value: '1' },
        { label: 'Female', value: '2' },
      ],
      type: FilterTypes.Picker,
    },
    sign_status: {
      label: 'Contract Type',
      value: '0',
      options: [
        { label: 'All', value: '0' },
        { label: 'Contracted', value: '1' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new WebnovelRating();

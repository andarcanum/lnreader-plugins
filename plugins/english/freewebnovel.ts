import { Parser } from 'htmlparser2';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { FilterTypes, Filters } from '@libs/filterInputs';

class FreeWebNovelPlugin implements Plugin.PluginBase {
  id = 'FWN.com';
  name = 'Free Web Novel';
  icon = 'multisrc/readnovelfull/fwn.com/icon.png';
  site = 'https://freewebnovel.com/';
  version = '2.2.4';

  lastSearch: number | null = null;
  searchInterval = 3400;

  // Кеш для всех глав (для ленивой загрузки)
  cachedChapters: Plugin.ChapterItem[] | null = null;

  async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  parseNovels(html: string) {
    const novels: Plugin.NovelItem[] = [];
    let currentNovel: Partial<Plugin.NovelItem> & {
      extraInfo?: { status?: string; chapters?: string };
    } = {};

    const pushCurrentNovel = () => {
      if (currentNovel.name && currentNovel.path) {
        let displayName = currentNovel.name;
        if (currentNovel.extraInfo) {
          const info = [];
          if (currentNovel.extraInfo.status)
            info.push(currentNovel.extraInfo.status);
          if (currentNovel.extraInfo.chapters)
            info.push(currentNovel.extraInfo.chapters);
          if (info.length > 0) displayName += ` (${info.join(', ')})`;
        }
        novels.push({
          name: displayName,
          path: currentNovel.path,
          cover: currentNovel.cover,
        } as Plugin.NovelItem);
      }
      currentNovel = {};
    };

    const stateStack: ParsingState[] = [ParsingState.Idle];
    const currentState = () => stateStack[stateStack.length - 1];
    const pushState = (state: ParsingState) => stateStack.push(state);
    const popState = () =>
      stateStack.length > 1 ? stateStack.pop() : currentState();

    const parser = new Parser({
      onopentag: (name, attribs) => {
        const state = currentState();
        const cls = attribs.class || '';
        const id = attribs.id || '';

        if (state === ParsingState.Idle) {
          if (
            cls.includes('archive') ||
            cls === 'col-content' ||
            cls.includes('ul-list1') ||
            id === 'list-page'
          ) {
            pushState(ParsingState.NovelList);
          }
        }

        if (currentState() === ParsingState.Idle) return;

        if (name === 'img') {
          const cover =
            attribs['data-src'] || attribs['data-cfsrc'] || attribs.src;
          if (cover && !cover.includes('icon')) {
            if (currentNovel.path && currentNovel.name) {
              pushCurrentNovel();
            }
            currentNovel.cover = new URL(cover, this.site).href;
          }
        }

        if (name === 'h3') {
          pushState(ParsingState.NovelName);
        }

        if (state === ParsingState.NovelName && name === 'a') {
          const href = attribs.href;
          if (href) {
            if (currentNovel.path && currentNovel.name) {
              pushCurrentNovel();
            }
            currentNovel.path = new URL(href, this.site).pathname.substring(1);
            currentNovel.name = attribs.title || '';
          }
        }

        if (cls.includes('s2') || cls.includes('full')) {
          pushState(ParsingState.Status);
          currentNovel.extraInfo = currentNovel.extraInfo || {};
        } else if (
          cls.includes('s3') ||
          cls.includes('s1') ||
          cls.includes('chapter') ||
          cls.includes('chr-text')
        ) {
          pushState(ParsingState.Chapter);
          currentNovel.extraInfo = currentNovel.extraInfo || {};
        }
      },

      ontext: data => {
        const text = data.trim();
        if (!text) return;
        const state = currentState();

        if (state === ParsingState.NovelName && !currentNovel.name) {
          currentNovel.name = text;
        } else if (state === ParsingState.Status) {
          if (
            text.toLowerCase().includes('full') ||
            text.toLowerCase().includes('completed')
          ) {
            currentNovel.extraInfo!.status = 'Completed';
          }
        } else if (state === ParsingState.Chapter) {
          if (
            text.toLowerCase().includes('chapter') ||
            (text.match(/^\d+/) && text.length < 10)
          ) {
            currentNovel.extraInfo!.chapters = text;
          }
        }
      },

      onclosetag: name => {
        const state = currentState();
        if (state === ParsingState.NovelName && name === 'h3') {
          popState();
        } else if (
          state === ParsingState.Status &&
          (name === 'span' || name === 'a' || name === 'div')
        ) {
          popState();
        } else if (
          state === ParsingState.Chapter &&
          (name === 'span' || name === 'a' || name === 'div')
        ) {
          popState();
        }
      },
    });

    parser.write(html);
    parser.end();
    pushCurrentNovel();

    return novels;
  }

  async popularNovels(
    pageNo: number,
    { filters, showLatestNovels }: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    const filterType = (filters?.type?.value as string) || 'sort/most-popular';
    const filterGenre = (filters?.genres?.value as string) || '';

    let url = '';
    const basePage = showLatestNovels
      ? 'sort/latest-novels'
      : filterGenre
        ? filterGenre
        : filterType;

    if (pageNo > 1) {
      url = `${this.site}${basePage}/${pageNo.toString()}.html`;
    } else {
      url = `${this.site}${basePage}`;
    }

    const result = await fetchApi(url);
    if (!result.ok) {
      throw new Error(`Could not reach site (${result.status})`);
    }
    const html = await result.text();
    return this.parseNovels(html);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = this.site + novelPath;
    const result = await fetchApi(url);
    const body = await result.text();

    const novel: Partial<Plugin.SourceNovel> = {
      path: novelPath,
      chapters: [],
    };
    const summaryParts: string[] = [];
    const genreArray: string[] = [];
    const infoParts: string[] = [];
    const chapters: Plugin.ChapterItem[] = [];
    let novelId: string | null = null;

    const stateStack: ParsingState[] = [ParsingState.Idle];
    const currentState = () => stateStack[stateStack.length - 1];
    const pushState = (state: ParsingState) => stateStack.push(state);
    const popState = () =>
      stateStack.length > 1 ? stateStack.pop() : currentState();

    const parser = new Parser({
      onopentag: (name, attribs) => {
        const state = currentState();
        switch (name) {
          case 'div':
            switch (attribs.class) {
              case 'books':
              case 'm-imgtxt':
                pushState(ParsingState.Cover);
                return;
              case 'inner':
              case 'desc-text':
                if (state === ParsingState.Cover) popState();
                pushState(ParsingState.Summary);
                break;
            }
            if (attribs.id === 'rating') {
              novelId = attribs['data-novel-id'];
            }
            break;
          case 'img':
            if (state === ParsingState.Cover) {
              const cover =
                attribs.src ?? attribs['data-cfsrc'] ?? attribs['data-src'];
              if (cover) novel.cover = new URL(cover, this.site).href;
              if (attribs.title) novel.name = attribs.title;
            }
            break;
          case 'h3':
            if (state === ParsingState.Cover) pushState(ParsingState.NovelName);
            break;
          case 'br':
            if (state === ParsingState.Summary) summaryParts.push('\n');
            break;
          case 'ul':
            if (attribs.class?.includes('info-meta')) {
              pushState(ParsingState.Info);
            } else if (attribs.id === 'idData') {
              pushState(ParsingState.ChapterList);
            }
            break;
          case 'a':
            if (state === ParsingState.Genres) {
              genreArray.push(attribs.title || '');
            } else if (state === ParsingState.ChapterList && attribs.href) {
              chapters.push({
                name: attribs.title || '',
                path: new URL(attribs.href, this.site).pathname.substring(1),
              });
            }
            break;
        }
      },

      ontext: data => {
        const text = data.trim();
        if (!text) return;
        const state = currentState();

        switch (state) {
          case ParsingState.NovelName:
            novel.name = (novel.name || '') + text;
            break;
          case ParsingState.Summary:
            summaryParts.push(data);
            break;
          case ParsingState.Info:
            const lower = text.toLowerCase();
            if (lower.includes('author:')) pushState(ParsingState.Author);
            else if (lower.includes('status:')) pushState(ParsingState.Status);
            else if (lower.includes('genre:')) pushState(ParsingState.Genres);
            break;
          case ParsingState.Author:
            novel.author = text;
            popState();
            break;
          case ParsingState.Status:
            const statusLower = text.toLowerCase();
            if (statusLower.includes('ongoing'))
              novel.status = NovelStatus.Ongoing;
            else if (statusLower.includes('hiatus'))
              novel.status = NovelStatus.OnHiatus;
            else if (statusLower.includes('completed'))
              novel.status = NovelStatus.Completed;
            else novel.status = NovelStatus.Unknown;
            popState();
            break;
        }
      },

      onclosetag: name => {
        const state = currentState();
        switch (name) {
          case 'div':
            if (state === ParsingState.Summary) popState();
            break;
          case 'h3':
            if (state === ParsingState.NovelName) popState();
            break;
          case 'ul':
            if (
              state === ParsingState.Info ||
              state === ParsingState.ChapterList
            )
              popState();
            break;
        }
      },
    });

    parser.write(body);
    parser.end();

    novel.summary = summaryParts.join('\n').trim();
    novel.genres = genreArray.join(', ');
    novel.chapters = chapters;

    if (novelId && chapters.length === 0) {
      const chaptersUrl = `${this.site}ajax/chapter-archive?novelId=${novelId}`;
      const ajaxResult = await fetchApi(chaptersUrl);
      if (ajaxResult.ok) {
        const ajaxBody = await ajaxResult.text();
        const ajaxChapters: Plugin.ChapterItem[] = [];
        let tempAjaxChapter: Partial<Plugin.ChapterItem> = {};

        const ajaxParser = new Parser({
          onopentag: (name, attribs) => {
            if (name === 'a' && attribs.href) {
              tempAjaxChapter.path = new URL(
                attribs.href,
                this.site,
              ).pathname.substring(1);
              tempAjaxChapter.name = attribs.title || '';
              pushState(ParsingState.Chapter);
            }
          },
          ontext: data => {
            if (
              currentState() === ParsingState.Chapter &&
              !tempAjaxChapter.name
            ) {
              tempAjaxChapter.name = data.trim();
            }
          },
          onclosetag: name => {
            if (name === 'a' && currentState() === ParsingState.Chapter) {
              if (tempAjaxChapter.path) {
                ajaxChapters.push(tempAjaxChapter as Plugin.ChapterItem);
              }
              tempAjaxChapter = {};
              popState();
            }
          },
        });
        ajaxParser.write(ajaxBody);
        ajaxParser.end();
        novel.chapters = ajaxChapters;
      }
    }

    return novel as Plugin.SourceNovel;
  }

  async parsePage(novelPath: string, page: string): Promise<Plugin.SourcePage> {
    if (!this.cachedChapters) {
      return { chapters: [] };
    }

    const pageNum = parseInt(page, 10) || 1;
    const startIndex = (pageNum - 1) * 100;
    const endIndex = Math.min(startIndex + 100, this.cachedChapters.length);

    return {
      chapters: this.cachedChapters.slice(startIndex, endIndex),
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const response = await fetchApi(this.site + chapterPath);
    const html = await response.text();

    let depth: number = 0;
    const chapterHtml: string[] = [];

    const stateStack: ParsingState[] = [ParsingState.Idle];
    const currentState = () => stateStack[stateStack.length - 1];
    const pushState = (state: ParsingState) => stateStack.push(state);
    const popState = () =>
      stateStack.length > 1 ? stateStack.pop() : currentState();

    const escapeCharMap: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    const escapeHtml = (text: string) =>
      text.replace(/[&<>"']/g, m => escapeCharMap[m]);

    const parser = new Parser({
      onopentag: (name, attribs) => {
        const state = currentState();
        const cls = attribs.class || '';
        const id = attribs.id || '';

        if (state === ParsingState.Idle) {
          if (
            cls.includes('txt') ||
            id === 'chr-content' ||
            id === 'chapter-content' ||
            id === 'article'
          ) {
            pushState(ParsingState.Chapter);
            depth = name === 'div' || name === 'article' ? 1 : 0;
          }
        } else if (state === ParsingState.Chapter) {
          if (name === 'div' || name === 'article') depth++;
          if (
            cls.includes('unlock-buttons') ||
            cls.includes('ads') ||
            id.includes('ads')
          ) {
            pushState(ParsingState.Hidden);
          } else if (name === 'script' || name === 'style') {
            pushState(ParsingState.Script);
          }
        } else if (state === ParsingState.Hidden) {
          if (name === 'div' || name === 'article') depth++;
        }

        if (currentState() === ParsingState.Chapter) {
          const attrStr = Object.keys(attribs)
            .map(k => ` ${k}="${attribs[k].replace(/"/g, '&quot;')}"`)
            .join('');
          chapterHtml.push(`<${name}${attrStr}>`);
        }
      },
      ontext: text => {
        if (currentState() === ParsingState.Chapter) {
          const cleanedText = text
            .replace(/Read more at freewebnovel\.com/gi, '')
            .replace(/Visit freewebnovel\.com for more chapters\./gi, '');
          chapterHtml.push(escapeHtml(cleanedText));
        }
      },
      onclosetag: name => {
        const state = currentState();
        if (state === ParsingState.Chapter) chapterHtml.push(`</${name}>`);

        if (
          state === ParsingState.Script &&
          (name === 'script' || name === 'style')
        ) {
          popState();
        }

        if (state === ParsingState.Hidden || state === ParsingState.Chapter) {
          if (name === 'div' || name === 'article') {
            depth--;
            if (depth <= 0) {
              if (state === ParsingState.Hidden) popState();
              popState();
              pushState(ParsingState.Stopped);
            } else if (state === ParsingState.Hidden && depth === 1) {
              popState();
            }
          }
        }
      },
    });

    parser.write(html);
    parser.end();

    return chapterHtml.join('');
  }

  async searchNovels(
    searchTerm: string,
    page: number,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({ searchkey: searchTerm });
    const url = `${this.site}search`;

    const fetchOptions: any = {
      method: 'POST',
      body: params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    };

    const result = await fetchApi(url, fetchOptions);

    if (!result.ok) throw new Error(`Could not reach site (${result.status})`);

    const html = await result.text();
    return this.parseNovels(html);
  }

  filters: Filters = {
    type: {
      label: 'Novel Type',
      value: 'sort/most-popular',
      options: [
        { label: 'Most Popular', value: 'sort/most-popular' },
        { label: 'Latest Release', value: 'sort/latest-release' },
        { label: 'Latest Novels', value: 'sort/latest-novel' },
        { label: 'Completed Novels', value: 'sort/completed-novel' },
        { label: 'Chinese Novel', value: 'sort/latest-release/chinese-novel' },
        { label: 'Korean Novel', value: 'sort/latest-release/korean-novel' },
        {
          label: 'Japanese Novel',
          value: 'sort/latest-release/japanese-novel',
        },
        { label: 'English Novel', value: 'sort/latest-release/english-novel' },
      ],
      type: FilterTypes.Picker,
    },
    genres: {
      label: 'Genre',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Action', value: 'genre/Action' },
        { label: 'Adult', value: 'genre/Adult' },
        { label: 'Adventure', value: 'genre/Adventure' },
        { label: 'Comedy', value: 'genre/Comedy' },
        { label: 'Drama', value: 'genre/Drama' },
        { label: 'Eastern', value: 'genre/Eastern' },
        { label: 'Ecchi', value: 'genre/Ecchi' },
        { label: 'Fantasy', value: 'genre/Fantasy' },
        { label: 'Game', value: 'genre/Game' },
        { label: 'Gender Bender', value: 'genre/Gender+Bender' },
        { label: 'Harem', value: 'genre/Harem' },
        { label: 'Historical', value: 'genre/Historical' },
        { label: 'Horror', value: 'genre/Horror' },
        { label: 'Josei', value: 'genre/Josei' },
        { label: 'Martial Arts', value: 'genre/Martial+Arts' },
        { label: 'Mature', value: 'genre/Mature' },
        { label: 'Mecha', value: 'genre/Mecha' },
        { label: 'Mystery', value: 'genre/Mystery' },
        { label: 'Psychological', value: 'genre/Psychological' },
        { label: 'Reincarnation', value: 'genre/Reincarnation' },
        { label: 'Romance', value: 'genre/Romance' },
        { label: 'School Life', value: 'genre/School+Life' },
        { label: 'Sci-fi', value: 'genre/Sci-fi' },
        { label: 'Seinen', value: 'genre/Seinen' },
        { label: 'Shoujo', value: 'genre/Shoujo' },
        { label: 'Shounen Ai', value: 'genre/Shounen+Ai' },
        { label: 'Shounen', value: 'genre/Shounen' },
        { label: 'Slice of Life', value: 'genre/Slice+of+Life' },
        { label: 'Smut', value: 'genre/Smut' },
        { label: 'Sports', value: 'genre/Sports' },
        { label: 'Supernatural', value: 'genre/Supernatural' },
        { label: 'Tragedy', value: 'genre/Tragedy' },
        { label: 'Wuxia', value: 'genre/Wuxia' },
        { label: 'Xianxia', value: 'genre/Xianxia' },
        { label: 'Xuanhuan', value: 'genre/Xuanhuan' },
        { label: 'Yaoi', value: 'genre/Yaoi' },
      ],
      type: FilterTypes.Picker,
    },
  };
}

enum ParsingState {
  Idle,
  Info,
  Cover,
  Author,
  Genres,
  Status,
  Hidden,
  Summary,
  Stopped,
  Chapter,
  ChapterList,
  NovelName,
  NovelList,
  NovelDetails,
  Script,
}

const plugin = new FreeWebNovelPlugin();
export default plugin;

import { Parser } from 'htmlparser2';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters } from '@libs/filterInputs';

type ReadNovelFullOptions = {
  lang?: string;
  versionIncrements?: number;
  preferNovelDetailCover?: boolean;
  latestPage: string;
  searchPage: string;
  chapterListing?: string;
  chapterParam?: string;
  pageParam?: string;
  novelListing?: string;
  typeParam?: string;
  genreParam?: string;
  genreKey?: string;
  langParam?: string;
  urlLangCode?: string;
  searchKey?: string;
  postSearch?: boolean;
  noAjax?: boolean;
  noPages?: string[];
  pageAsPath?: boolean;
};

export type ReadNovelFullMetadata = {
  id: string;
  sourceSite: string;
  sourceName: string;
  options: ReadNovelFullOptions;
  filters?: any;
};

class ReadNovelFullPlugin implements Plugin.PluginBase {
  id: string;
  name: string;
  icon: string;
  site: string;
  version: string;
  options: ReadNovelFullOptions;
  filters?: Filters | undefined;
  detailCoverCache: Record<string, string | null> = {};

  constructor(metadata: ReadNovelFullMetadata) {
    this.id = metadata.id;
    this.name = metadata.sourceName;
    this.icon = `multisrc/readnovelfull/${metadata.id.toLowerCase()}/icon.png`;
    this.site = metadata.sourceSite;
    const versionIncrements = metadata.options?.versionIncrements || 0;
    this.version = `2.1.${5 + versionIncrements}`;
    this.options = metadata.options;
    this.filters = metadata.filters;
  }

  lastSearch: number | null = null;
  searchInterval = 3400;

  async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  normalizeCoverUrl(cover: string): string {
    if (this.id === 'novelbin') {
      return cover.replace('/novel_200_89/', '/novel/');
    }

    return cover;
  }

  extractDetailCover(html: string): string | null {
    let detailCover: string | null = null;
    let inCoverBlock = false;
    let depth = 0;

    const parser = new Parser({
      onopentag: (name, attribs) => {
        if (detailCover) return;

        if (name === 'div') {
          const cls = attribs.class || '';
          if (
            !inCoverBlock &&
            (cls.includes('books') || cls.includes('m-imgtxt'))
          ) {
            inCoverBlock = true;
            depth = 0;
            return;
          }

          if (inCoverBlock) {
            depth++;
          }
        }

        if (inCoverBlock && name === 'img') {
          const cover =
            attribs.src ?? attribs['data-cfsrc'] ?? attribs['data-src'];
          if (cover && !cover.startsWith('data:image/')) {
            detailCover = this.normalizeCoverUrl(
              new URL(cover, this.site).href,
            );
          }
        }
      },
      onclosetag: name => {
        if (!inCoverBlock || name !== 'div') return;

        depth--;
        if (depth < 0) {
          inCoverBlock = false;
        }
      },
    });

    parser.write(html);
    parser.end();

    return detailCover;
  }

  async getNovelDetailCover(novelPath: string): Promise<string | null> {
    const cachedCover = this.detailCoverCache[novelPath];
    if (typeof cachedCover !== 'undefined') {
      return cachedCover;
    }

    try {
      const result = await fetchApi(`${this.site}${novelPath}`);
      if (!result.ok) {
        this.detailCoverCache[novelPath] = null;
        return null;
      }

      const html = await result.text();
      const detailCover = this.extractDetailCover(html);
      this.detailCoverCache[novelPath] = detailCover;
      return detailCover;
    } catch {
      this.detailCoverCache[novelPath] = null;
      return null;
    }
  }

  async resolveNovelCovers(
    novels: Plugin.NovelItem[],
  ): Promise<Plugin.NovelItem[]> {
    const result: Plugin.NovelItem[] = [];
    const chunkSize = 4;

    for (let i = 0; i < novels.length; i += chunkSize) {
      const chunk = novels.slice(i, i + chunkSize);
      const resolvedChunk = await Promise.all(
        chunk.map(async novel => {
          if (!novel.path) return novel;

          const detailCover = await this.getNovelDetailCover(novel.path);
          if (!detailCover) return novel;

          return {
            ...novel,
            cover: this.normalizeCoverUrl(detailCover),
          };
        }),
      );

      result.push(...resolvedChunk);
    }

    return result;
  }

  parseNovels(html: string) {
    const novels: Plugin.NovelItem[] = [];
    let tempNovel: Partial<Plugin.NovelItem> = {};
    let depth: number = 0;

    const stateStack: ParsingState[] = [ParsingState.Idle];
    const currentState = () => stateStack[stateStack.length - 1];
    const pushState = (state: ParsingState) => stateStack.push(state);
    const popState = () =>
      stateStack.length > 1 ? stateStack.pop() : currentState();
    const isMainNovelListContainer = (cls: string) => {
      const isListNovel =
        cls.includes('list-novel') &&
        !cls.includes('list-side') &&
        !cls.includes('list-cat');
      const isListTruyen =
        cls.includes('list-truyen') &&
        !cls.includes('list-side') &&
        !cls.includes('list-cat');

      return cls.includes('col-content') || isListNovel || isListTruyen;
    };

    const parser = new Parser({
      onopentag: (name, attribs) => {
        const state = currentState();
        const cls = attribs.class || '';

        if (state === ParsingState.Idle) {
          if (isMainNovelListContainer(cls)) {
            pushState(ParsingState.NovelList);
            depth = 0;
          }
          return;
        }

        if (state === ParsingState.NovelList) {
          if (name === 'div') depth++;
          if (name === 'h3') {
            pushState(ParsingState.NovelName);
          }
          if (name === 'img') {
            const cover =
              attribs['data-src'] || attribs['data-cfsrc'] || attribs.src;
            if (cover && !cover.startsWith('data:image/')) {
              tempNovel.cover = this.normalizeCoverUrl(
                new URL(cover, this.site).href,
              );
            }
          }
        } else if (state === ParsingState.NovelName) {
          if (name === 'a') {
            const href = attribs.href;
            if (href) {
              tempNovel.path = new URL(href, this.site).pathname.substring(1);
              tempNovel.name = attribs.title;
            }
          }
        }
      },

      ontext: data => {
        const state = currentState();
        if (state === ParsingState.NovelName && !tempNovel.name) {
          tempNovel.name = data.trim();
        }
      },

      onclosetag: name => {
        const state = currentState();
        if (
          state === ParsingState.NovelName &&
          (name === 'h3' || name === 'a')
        ) {
          if (tempNovel.name && tempNovel.path) {
            novels.push({ ...tempNovel } as Plugin.NovelItem);
            tempNovel = {};
          }
          popState();
        } else if (state === ParsingState.NovelList && name === 'div') {
          depth--;
          if (depth < 0) popState();
        }
      },
    });

    parser.write(html);
    parser.end();

    return novels;
  }

  async popularNovels(
    pageNo: number,
    { filters, showLatestNovels }: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    const {
      pageParam = 'page',
      novelListing,
      typeParam = 'type',
      latestPage,
      genreParam = 'category_novel',
      genreKey = 'id',
      langParam,
      urlLangCode,
      noPages = [],
      pageAsPath = false,
    } = this.options;

    const filterType = (filters?.type?.value as string) || '';
    const filterGenre = (filters?.genres?.value as string) || '';

    // Skip Pagination for FWN & LR
    if (
      pageNo !== 1 &&
      !showLatestNovels &&
      !filterGenre.length &&
      noPages &&
      noPages.length > 0 &&
      noPages.includes(filterType)
    ) {
      return [];
    }

    let url = '';

    if (novelListing) {
      // URL structure with parameters
      const params = new URLSearchParams();

      if (showLatestNovels) {
        params.append(typeParam, latestPage);
      } else if (filterGenre.length) {
        params.append(typeParam, genreParam);
        params.append(genreKey, filterGenre);
      } else {
        params.append(typeParam, filterType);
      }

      // Add language parameter if specified
      if (langParam && urlLangCode) {
        params.append(langParam, urlLangCode);
      }

      params.append(pageParam, pageNo.toString());
      url = `${this.site}${novelListing}?${params.toString()}`;
    } else {
      // URL structure with path segments
      const basePage = showLatestNovels
        ? latestPage
        : filterGenre.length
          ? filterGenre
          : filterType;

      if (pageAsPath) {
        if (pageNo > 1) {
          url = `${this.site}${basePage}/${pageNo.toString()}`;
        } else {
          url = `${this.site}${basePage}`;
        }
      } else {
        url = `${this.site}${basePage}?${pageParam}=${pageNo.toString()}`;
      }
    }

    const result = await fetchApi(url);
    if (!result.ok) {
      throw new Error(
        `Could not reach site (${result.status}: ${result.statusText}) try to open in webview.`,
      );
    }
    const html = await result.text();
    const novels = this.parseNovels(html);

    if (!this.options.preferNovelDetailCover) {
      return novels;
    }

    return this.resolveNovelCovers(novels);
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
    const statusParts: string[] = [];
    const authorParts: string[] = [];
    const genreArray: string[] = [];
    const infoParts: string[] = [];
    const chapters: Plugin.ChapterItem[] = [];
    let novelId: string | null = null;
    let tempChapter: Partial<Plugin.ChapterItem> = {};
    let i = 0;
    let depth: number = 0;

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
              case 'info':
                pushState(ParsingState.Info);
                depth = 0;
                break;
            }
            if (!this.options.noAjax && attribs.id === 'rating') {
              novelId = attribs['data-novel-id'];
            }
            if (state === ParsingState.Info) depth++;
            break;
          case 'img':
            if (state === ParsingState.Cover) {
              const cover =
                attribs.src ?? attribs['data-cfsrc'] ?? attribs['data-src'];
              const name = attribs.title;
              if (cover) {
                novel.cover = this.normalizeCoverUrl(
                  new URL(cover, this.site).href,
                );
              }
              if (name) {
                novel.name = name;
              } else {
                popState();
              }
            }
            break;
          case 'h3':
            if (state === ParsingState.Cover) {
              pushState(ParsingState.NovelName);
            }
            break;
          case 'span':
            if (state === ParsingState.Cover && attribs.title) {
              const newState = {
                'Genre': ParsingState.Genres,
                'Author': ParsingState.Author,
                'Status': ParsingState.Status,
              }[attribs.title];

              if (newState) pushState(newState);
            }
            break;
          case 'br':
            if (state === ParsingState.Summary) {
              summaryParts.push('\n');
            }
            break;
          case 'ul':
            if (attribs.class?.includes('info-meta')) {
              pushState(ParsingState.Info);
            }
            if (this.options.noAjax && attribs.id === 'idData') {
              pushState(ParsingState.ChapterList);
            }
            break;
          case 'a':
            if (state === ParsingState.ChapterList) {
              i++;
              const href = attribs.href;
              pushState(ParsingState.Chapter);

              tempChapter.name = attribs.title || `Chapter ${i}`;
              tempChapter.releaseTime = null;
              tempChapter.chapterNumber = i;
              tempChapter.path =
                href?.substring(1) ||
                novelPath.replace('.html', `/chapter-${i}.html`);
            }
            break;
        }
      },

      ontext: data => {
        const text = data.trim();
        if (!text) return;

        switch (currentState()) {
          case ParsingState.NovelName:
            novel.name = (novel.name || '') + text;
            break;
          case ParsingState.Summary:
            summaryParts.push(data);
            break;
          case ParsingState.Info:
            infoParts.push(text);
            break;
          case ParsingState.Genres:
            genreArray.push(data);
            break;
          case ParsingState.Author:
            authorParts.push(data);
            break;
          case ParsingState.Status:
            statusParts.push(text);
            break;
        }
      },

      onclosetag: name => {
        const state = currentState();
        switch (name) {
          case 'div':
            switch (state) {
              case ParsingState.Info:
                depth--;
                infoParts.push('\n');
                if (depth < 0) {
                  popState();
                }
                break;
              case ParsingState.Genres:
              case ParsingState.Author:
              case ParsingState.Status:
              case ParsingState.Summary:
                popState();
                break;
            }
            break;
          case 'h3':
            if (state === ParsingState.NovelName) {
              popState();
            }
            break;
          case 'a':
            if (state === ParsingState.Chapter) {
              if (tempChapter.name && tempChapter.path) {
                chapters.push({ ...tempChapter } as Plugin.ChapterItem);
              }
              tempChapter = {};
              popState();
            }
            break;
          case 'li':
            if (state === ParsingState.Info) {
              infoParts.push('\n');
            }
            break;
          case 'ul':
            switch (state) {
              case ParsingState.Info:
              case ParsingState.ChapterList:
                popState();
                break;
            }
            break;
          default:
            return;
        }
      },

      onend: () => {
        if (infoParts.length) {
          infoParts
            .join('')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.includes(':'))
            .forEach(line => {
              const parts = line.split(':');
              const detailName = parts[0].trim().toLowerCase();
              const detail = parts[1]
                .split(',')
                .map(g => g.trim())
                .join(', ');

              switch (detailName) {
                case 'author':
                  novel.author = detail;
                  break;
                case 'genre':
                  novel.genres = detail;
                  break;
                case 'status':
                  const map: Record<string, string> = {
                    ongoing: NovelStatus.Ongoing,
                    hiatus: NovelStatus.OnHiatus,
                    dropped: NovelStatus.Cancelled,
                    cancelled: NovelStatus.Cancelled,
                    completed: NovelStatus.Completed,
                  };
                  novel.status =
                    map[detail.toLowerCase()] ?? NovelStatus.Unknown;
                  break;
                default:
                  return;
              }
            });

          if (!novelId) {
            const idMatch = novelPath.match(/\d+/);
            novelId = idMatch ? idMatch[0] : null;
          }
        } else {
          novel.genres = genreArray.join('').trim();
          novel.author = authorParts.join('').trim();
          novel.status = statusParts
            .join('')
            .toLowerCase()
            .replace(/\b\w/g, char => char.toUpperCase());
        }
        novel.summary = summaryParts.join('\n\n').trim();
      },
    });

    parser.write(body);
    parser.end();

    if (this.options.noAjax && chapters.length > 0) {
      novel.chapters = chapters;
    } else if (novelId !== null) {
      const chapterListing =
        this.options.chapterListing || 'ajax/chapter-archive';
      const ajaxParam = this.options.chapterParam || 'novelId';
      const params = new URLSearchParams({ [ajaxParam]: novelId });
      const chaptersUrl = `${this.site}${chapterListing}?${params.toString()}`;

      const ajaxResult = await fetchApi(chaptersUrl);
      if (!ajaxResult.ok) {
        console.error(`Failed to fetch chapters: ${ajaxResult.status}`);
        novel.chapters = [];
      } else {
        const ajaxBody = await ajaxResult.text();
        const ajaxChapters: Plugin.ChapterItem[] = [];
        let tempAjaxChapter: Partial<Plugin.ChapterItem> = {};

        const ajaxParser = new Parser({
          onopentag: (name, attribs) => {
            let chapterHref: string | undefined;
            let initialName: string | undefined;

            if (name === 'a' && attribs.href) {
              chapterHref = attribs.href;
              initialName = attribs.title || '';
              pushState(ParsingState.Chapter);
            } else if (name === 'option' && attribs.value) {
              chapterHref = attribs.value;
              initialName = '';
              pushState(ParsingState.Chapter);
            }

            if (chapterHref !== undefined) {
              const href = new URL(chapterHref, this.site);
              tempAjaxChapter.path = href.pathname.substring(1);
              tempAjaxChapter.name = initialName;
            }
          },

          ontext: data => {
            const text = data.trim();
            if (
              currentState() === ParsingState.Chapter &&
              !tempAjaxChapter.name &&
              text
            ) {
              tempAjaxChapter.name += text;
            }
          },

          onclosetag: name => {
            if (
              (name === 'a' || name === 'option') &&
              currentState() === ParsingState.Chapter
            ) {
              if (tempAjaxChapter.name && tempAjaxChapter.path) {
                tempAjaxChapter.name = tempAjaxChapter.name.trim();
                tempAjaxChapter.releaseTime = null;
                ajaxChapters.push({
                  ...tempAjaxChapter,
                } as Plugin.ChapterItem);
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

  async parseChapter(chapterPath: string): Promise<string> {
    const response = await fetchApi(this.site + chapterPath);
    const html = await response.text();

    let depth: number = 0;
    let depthHide: number = 0;
    const chapterHtml: string[] = [];
    let skipClosingTag = false;
    let currentTagToSkip = '';

    const stateStack: ParsingState[] = [ParsingState.Idle];
    const currentState = () => stateStack[stateStack.length - 1];
    const pushState = (state: ParsingState) => stateStack.push(state);
    const popState = () =>
      stateStack.length > 1 ? stateStack.pop() : currentState();

    type EscapeChar = '&' | '<' | '>' | '"' | "'" | ' ';
    const escapeRegex = /[&<>"' ]/g;
    const escapeMap: Record<EscapeChar, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      ' ': '&nbsp;',
    };
    const escapeHtml = (text: string): string =>
      text.replace(escapeRegex, char => escapeMap[char as EscapeChar]);

    const parser = new Parser({
      onopentag(name, attribs) {
        const state = currentState();
        const attrib = attribs.class?.trim();
        switch (state) {
          case ParsingState.Idle:
            if (
              attrib === 'txt' ||
              attribs.id === 'chr-content' ||
              attribs.id === 'chapter-content'
            ) {
              pushState(ParsingState.Chapter);
              depth = 0;
            }
            break;
          case ParsingState.Chapter:
            if (name === 'sub') {
              pushState(ParsingState.Hidden);
            } else if (name === 'div') {
              depth++;
              if (
                attrib?.includes('unlock-buttons') ||
                attrib?.includes('ads')
              ) {
                pushState(ParsingState.Hidden);
                depthHide = 0;
              }
            }
            break;
          case ParsingState.Hidden:
            if (name === 'sub') {
              pushState(ParsingState.Hidden);
            } else if (name === 'div') {
              depthHide++;
            }
            break;
          default:
            return;
        }

        if (currentState() === ParsingState.Chapter) {
          const attrKeys = Object.keys(attribs);

          if (attrKeys.length === 0) {
            chapterHtml.push(`<${name}>`);
          } else if (attrKeys.every(key => attribs[key].trim() === '')) {
            skipClosingTag = true;
            currentTagToSkip = name;
            const uppercaseName = name.replace(/\b\w/g, char =>
              char.toUpperCase(),
            );
            chapterHtml.push(
              escapeHtml(`<${uppercaseName} ${attrKeys.join(' ')}>`),
            );
          } else {
            const attrString = attrKeys
              .map(key => ` ${key}="${attribs[key].replace(/"/g, '&quot;')}"`)
              .join('');
            chapterHtml.push(`<${name}${attrString}>`);
          }
        }
      },

      ontext(text) {
        if (currentState() === ParsingState.Chapter) {
          chapterHtml.push(escapeHtml(text));
        }
      },

      onclosetag(name) {
        const state = currentState();

        if (state === ParsingState.Hidden) {
          if (name === 'sub') {
            popState();
          } else if (name === 'div') {
            depthHide--;
            if (depthHide < 0) {
              popState();
              depth--;
            }
          }
        }

        if (state !== ParsingState.Chapter) {
          return;
        }

        if (!parser['isVoidElement'](name)) {
          if (skipClosingTag && name === currentTagToSkip) {
            skipClosingTag = false;
            currentTagToSkip = '';
          } else {
            chapterHtml.push(`</${name}>`);
          }
        }

        if (name === 'div') {
          depth--;
          if (depth < 0) {
            pushState(ParsingState.Stopped);
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
    const now = Date.now();
    if (this.lastSearch && now - this.lastSearch <= this.searchInterval) {
      await this.sleep(this.searchInterval);
    }

    const {
      pageParam = 'page',
      searchKey = 'keyword',
      postSearch,
      langParam,
      urlLangCode,
      searchPage,
    } = this.options;

    const params = new URLSearchParams({
      [searchKey]: searchTerm,
      ...(langParam && urlLangCode && { [langParam]: urlLangCode }),
      ...(!postSearch && { [pageParam]: page.toString() }),
    });

    const url = `${this.site}${searchPage}${!postSearch ? `?${params.toString()}` : ''}`;

    const fetchOptions: any = postSearch
      ? {
          method: 'POST',
          body: params.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      : undefined;

    const result = await fetchApi(url, fetchOptions);
    this.lastSearch = Date.now();

    if (!result.ok) {
      throw new Error(
        `Could not reach site ('${result.status}') try to open in webview.`,
      );
    }

    const html = await result.text();

    const alertText = html.match(/alert\((.*?)\)/)?.[1] || '';
    if (alertText) throw new Error(alertText);

    return this.parseNovels(html);
  }
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
}

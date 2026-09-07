import {
  ADAPTERS_QUERY_LIMIT,
  RESPONSE_COMPARE_MIN_INCLUSION_SCORE,
  RESPONSE_COMPARE_MIN_SCORE,
} from '~/config/constants';
import { Adapter, MetadataType, Parser } from '~/config/enum';
import { ENV } from '~/config/env';
import { cacheSearchResultLink, getCachedSearchResultLink } from '~/services/cache';
import type { SearchMetadata, SearchResultLink } from '~/services/search';
import {
  findBestMatch,
  getResultWithBestScore,
  type MatchCandidate,
} from '~/utils/compare';
import HttpClient from '~/utils/http-client';
import { logger } from '~/utils/logger';
import { getCheerioDoc } from '~/utils/scraper';
import { getServiceGuard } from '~/utils/service-guard';

const APPLE_MUSIC_SEARCH_TYPES = {
  [MetadataType.Song]: 'Songs',
  [MetadataType.Album]: 'Albums',
  [MetadataType.Playlist]: 'Playlists',
  [MetadataType.Artist]: 'Artists',
  [MetadataType.Podcast]: undefined,
  [MetadataType.Show]: undefined,
};

function isSongUrl(href: string): boolean {
  try {
    const url = new URL(href);
    if (!['music.apple.com', 'geo.music.apple.com'].includes(url.hostname)) {
      return false;
    }
    return (
      (/\/album\//.test(url.pathname) && /^\d+$/.test(url.searchParams.get('i') ?? '')) ||
      /\/song\/(?:[^/]+\/)?\d+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export async function getAppleMusicLink(
  query: string,
  metadata: SearchMetadata,
  sourceParser: Parser,
  sourceId: string
) {
  const searchType = APPLE_MUSIC_SEARCH_TYPES[metadata.type];
  if (!searchType) return null;

  // x-www-form-urlencoded encoding required for browser url
  const params = `term=${encodeURIComponent(query)}`;

  const url = new URL(`${ENV.adapters.appleMusic.apiUrl}/search?${params}`);

  const cache = await getCachedSearchResultLink(
    Adapter.AppleMusic,
    sourceParser,
    sourceId
  );
  if (cache && (metadata.type !== MetadataType.Song || isSongUrl(cache.url))) {
    logger.info(`[Apple Music] (${url}) cache hit`);
    return cache;
  }

  const guard = getServiceGuard('appleMusic');
  if (!guard.acquire()) {
    logger.warn('[Apple Music] service guard: request blocked');
    return null;
  }

  try {
    const html = await HttpClient.get<string>(url.toString());
    guard.recordSuccess();
    const doc = getCheerioDoc(html);

    let href: string;
    let score: number;
    if (metadata.type === MetadataType.Song) {
      const candidates: MatchCandidate[] = [];
      doc('div[aria-label="Songs"] [data-testid="track-lockup"]').each((_, element) => {
        const row = doc(element);
        const titleLink = row.find('[data-testid="track-lockup-title"] a[href]').first();
        const url = titleLink.attr('href');
        const title = titleLink.text().trim();
        if (url && title && isSongUrl(url)) {
          candidates.push({
            title,
            artist: row.find('[data-testid="track-lockup-subtitle"]').text().trim(),
            url,
          });
        }
      });
      const { bestMatch, highestScore } = findBestMatch(
        candidates.slice(0, ADAPTERS_QUERY_LIMIT),
        query,
        Adapter.AppleMusic
      );
      if (!bestMatch) throw new Error(`No Apple Music song found for: ${query}`);
      href = bestMatch.url;
      score = highestScore;
    } else {
      const listElements = doc(
        `div[aria-label="${searchType}"] a[href^="https://music.apple.com/"]:lt(3)`
      );
      ({ href, score } = getResultWithBestScore(doc, listElements, query));
    }

    // Convert music.apple.com links to geo.music.apple.com links for better results
    const geoUrl = href.replace('music.apple.com', 'geo.music.apple.com');

    if (href !== geoUrl) {
      logger.info(`[Apple Music] transformed to geo link: ${geoUrl}`);
    }

    const searchResultLink = {
      type: Adapter.AppleMusic,
      url: geoUrl,
      isVerified: score >= RESPONSE_COMPARE_MIN_SCORE,
      notAvailable: score < RESPONSE_COMPARE_MIN_INCLUSION_SCORE,
    } as SearchResultLink;

    logger.info(
      `[Apple Music] Result score: ${score.toFixed(3)} (verified: ${searchResultLink.isVerified ? 'yes' : 'no'}, available: ${!searchResultLink.notAvailable ? 'yes' : 'no'})`
    );

    await cacheSearchResultLink(
      Adapter.AppleMusic,
      sourceParser,
      sourceId,
      searchResultLink
    );

    return searchResultLink;
  } catch (err) {
    guard.recordFailure();
    logger.error(`[Apple Music] (${url}) ${err} `);
    return null;
  }
}

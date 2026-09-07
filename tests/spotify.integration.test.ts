import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { getSpotifyLink } from '~/adapters/spotify';
import { Adapter, MetadataType, Parser } from '~/config/enum';
import { ENV } from '~/config/env';
import { getSpotifyMetadata } from '~/parsers/spotify';
import { cacheSpotifyAccessToken, cacheStore } from '~/services/cache';
import HttpClient from '~/utils/http-client';

const trackUrl = 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b';
const trackHtml = `<html><head>
  <meta property="og:title" content="Blinding Lights">
  <meta property="og:description" content="The Weeknd · After Hours · Song · 2020">
  <meta property="og:type" content="music.song">
  <meta property="og:image" content="https://i.scdn.co/image/test">
</head></html>`;
const metadata = {
  title: 'Blinding Lights',
  description: 'The Weeknd',
  type: MetadataType.Song,
};
const searchResults = {
  tracks: {
    items: [
      {
        track: {
          uri: 'spotify:track:wrong',
          name: 'Unrelated Song',
          artists: { items: [{ profile: { name: 'Other Artist' } }] },
        },
      },
      {
        track: {
          uri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b',
          name: 'Blinding Lights',
          artists: { items: [{ profile: { name: 'The Weeknd' } }] },
        },
      },
    ],
  },
};

describe('Spotify live-response regressions', () => {
  let getSpy: ReturnType<typeof spyOn<typeof HttpClient, 'get'>>;
  let postSpy: ReturnType<typeof spyOn<typeof HttpClient, 'post'>>;

  beforeEach(async () => {
    cacheStore.reset();
    await cacheSpotifyAccessToken(
      { accessToken: 'test-token', expiresAt: Math.floor(Date.now() / 1000) + 14400 },
      14400
    );
    getSpy = spyOn(HttpClient, 'get').mockImplementation(async () => {
      throw new Error('Unexpected GET');
    });
    postSpy = spyOn(HttpClient, 'post').mockImplementation(async () => {
      throw new Error('Unexpected POST');
    });
  });

  afterEach(() => {
    getSpy.mockRestore();
    postSpy.mockRestore();
    cacheStore.reset();
  });

  it('requests song metadata instead of the generic web-player HTML', async () => {
    getSpy.mockImplementation((async (_url, options) => {
      return options?.headers?.['User-Agent'] === 'facebookexternalhit/1.1'
        ? trackHtml
        : '<html><title>Spotify – Web Player</title></html>';
    }) as typeof HttpClient.get);
    const result = await getSpotifyMetadata('track-id', trackUrl);
    expect(result.title).toBe('Blinding Lights');
    expect(result.type).toBe(MetadataType.Song);
    expect(result.image).toBe('https://i.scdn.co/image/test');
  });

  it('preserves metadata headers when following a mobile link', async () => {
    getSpy.mockImplementation((async (url, options) => {
      expect(options?.headers?.['User-Agent']).toBe('facebookexternalhit/1.1');
      return url.includes('spotify.link') ? `<a href="${trackUrl}">Track</a>` : trackHtml;
    }) as typeof HttpClient.get);
    const result = await getSpotifyMetadata(
      'mobile-id',
      'https://spotify.link/abcdefghijk'
    );
    expect(result.title).toBe('Blinding Lights');
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  for (const root of ['search', 'searchV2']) {
    it(`POSTs GraphQL and selects the matching track from ${root}`, async () => {
      postSpy.mockResolvedValue({ data: { [root]: searchResults } });
      const result = await getSpotifyLink(
        'Blinding Lights The Weeknd',
        metadata,
        Parser.AppleMusic,
        'source-id'
      );
      expect(result).toEqual({
        type: Adapter.Spotify,
        url: trackUrl,
        isVerified: true,
        notAvailable: false,
      });
      expect(postSpy).toHaveBeenCalledWith(
        `${ENV.adapters.spotify.apiUrl}/query`,
        expect.objectContaining({
          operationName: 'searchDesktop',
          variables: expect.objectContaining({
            searchTerm: 'Blinding Lights The Weeknd',
          }),
          extensions: expect.objectContaining({ persistedQuery: expect.any(Object) }),
        }),
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-token',
            'app-platform': 'WebPlayer',
            'Content-Type': 'application/json',
          },
        })
      );
      expect(getSpy).not.toHaveBeenCalled();
    });
  }

  it('does not cache an HTTP-200 GraphQL error as a search success', async () => {
    postSpy.mockResolvedValueOnce({ errors: [{ message: 'PersistedQueryNotFound' }] });
    postSpy.mockResolvedValueOnce({ data: { search: searchResults } });
    expect(
      await getSpotifyLink(
        'Blinding Lights The Weeknd',
        metadata,
        Parser.AppleMusic,
        'source-id'
      )
    ).toBeNull();
    expect(
      await getSpotifyLink(
        'Blinding Lights The Weeknd',
        metadata,
        Parser.AppleMusic,
        'source-id'
      )
    ).toMatchObject({ url: trackUrl });
    expect(postSpy).toHaveBeenCalledTimes(2);
  });
});

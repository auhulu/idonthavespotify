import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { getAppleMusicLink } from '~/adapters/apple-music';
import { Adapter, MetadataType, Parser } from '~/config/enum';
import { cacheSearchResultLink, cacheStore } from '~/services/cache';
import HttpClient from '~/utils/http-client';
import { getServiceGuard } from '~/utils/service-guard';

const songUrl = 'https://music.apple.com/ca/album/bad-guy/1450695723?i=1450695739';
const artistUrl = 'https://music.apple.com/ca/artist/billie-eilish/1065981054';
const geoSongUrl = songUrl.replace('music.apple.com', 'geo.music.apple.com');
const metadata = {
  title: 'bad guy',
  description: 'Billie Eilish',
  type: MetadataType.Song,
};
const row = (title: string, artist: string, url = songUrl) => `
  <div data-testid="track-lockup">
    <div data-testid="track-lockup-title"><a href="${url}">${title}</a></div>
    <div data-testid="track-lockup-subtitle"><a href="${artistUrl}">${artist}</a></div>
  </div>`;
const search = () =>
  getAppleMusicLink('Billie Eilish - bad guy', metadata, Parser.YouTube, 'video-id');

describe('Apple Music song matching', () => {
  let getMock: ReturnType<typeof spyOn<typeof HttpClient, 'get'>>;
  let guardMock: ReturnType<typeof spyOn<ReturnType<typeof getServiceGuard>, 'acquire'>>;

  beforeEach(() => {
    cacheStore.reset();
    getMock = spyOn(HttpClient, 'get');
    guardMock = spyOn(getServiceGuard('appleMusic'), 'acquire').mockReturnValue(true);
  });
  afterEach(() => {
    getMock.mockRestore();
    guardMock.mockRestore();
    cacheStore.reset();
  });

  it('returns the song rather than the more similar artist link', async () => {
    getMock.mockResolvedValue(
      `<div aria-label="Songs">${row('bad guy', 'Billie Eilish')}</div>`
    );
    expect(await search()).toEqual({
      type: Adapter.AppleMusic,
      url: geoSongUrl,
      isVerified: true,
      notAvailable: false,
    });
  });

  it('compares artists from the same row to distinguish identically named songs', async () => {
    getMock.mockResolvedValue(`<div aria-label="Songs">
      ${row('bad guy', 'Cover Artist', 'https://music.apple.com/ca/album/bad-guy/123?i=456')}
      ${row('bad guy', 'Billie Eilish')}
    </div>`);
    expect(await search()).toMatchObject({ url: geoSongUrl, isVerified: true });
  });

  it('does not count artist links against the song candidate limit', async () => {
    getMock.mockResolvedValue(`<div aria-label="Songs">
      ${row('bad guy', 'Cover Artist One', 'https://music.apple.com/ca/album/cover/123?i=1')}
      ${row('bad guy', 'Cover Artist Two', 'https://music.apple.com/ca/album/cover/123?i=2')}
      ${row('bad guy', 'Billie Eilish')}
    </div>`);
    expect(await search()).toMatchObject({ url: geoSongUrl });
  });

  it('rejects artist, album-only, and off-platform URLs as song candidates', async () => {
    getMock.mockResolvedValue(`<div aria-label="Songs">
      ${row('bad guy', 'Billie Eilish', artistUrl)}
      ${row('bad guy', 'Billie Eilish', 'https://music.apple.com/ca/album/bad-guy/1450695723')}
      ${row('bad guy', 'Billie Eilish', 'https://example.com/song/bad-guy/123')}
    </div>`);
    expect(await search()).toBeNull();
  });

  it('supports direct song URLs', async () => {
    getMock.mockResolvedValue(
      `<div aria-label="Songs">${row('bad guy', 'Billie Eilish', 'https://music.apple.com/ca/song/bad-guy/1450695739')}</div>`
    );
    expect(await search()).toMatchObject({
      url: 'https://geo.music.apple.com/ca/song/bad-guy/1450695739',
    });
  });

  it('refreshes a previously cached artist URL and reuses the corrected song', async () => {
    await cacheSearchResultLink(Adapter.AppleMusic, Parser.YouTube, 'video-id', {
      type: Adapter.AppleMusic,
      url: artistUrl,
      isVerified: true,
    });
    getMock.mockResolvedValue(
      `<div aria-label="Songs">${row('bad guy', 'Billie Eilish')}</div>`
    );
    expect(await search()).toMatchObject({ url: geoSongUrl });
    expect(await search()).toMatchObject({ url: geoSongUrl });
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('returns no candidate when the song section is empty', async () => {
    getMock.mockResolvedValue(
      `<div aria-label="Artists"><a href="${artistUrl}">Billie Eilish</a></div>`
    );
    expect(await search()).toBeNull();
  });

  it('continues to allow artist URLs when searching for an artist', async () => {
    getMock.mockResolvedValue(
      `<div aria-label="Artists"><a href="${artistUrl}">Billie Eilish</a></div>`
    );
    expect(
      await getAppleMusicLink(
        'Billie Eilish',
        { ...metadata, type: MetadataType.Artist },
        Parser.Spotify,
        'artist-id'
      )
    ).toMatchObject({ url: artistUrl.replace('music.apple.com', 'geo.music.apple.com') });
  });
});

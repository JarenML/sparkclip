"""Kick saved videos use the guarded kick:vod extractor, like Twitch VODs."""
import asyncio
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from clip_engine.error_policy import safe_failure_code, safe_processing_error, safe_job_error_text
from clip_engine.services import video_downloader as module

VOD_ID = '191061c4-3c2e-46e8-83ef-eca789c89b3c'
URL = f'https://kick.com/elzeein/videos/{VOD_ID}'

@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(module, 'get_settings', lambda: SimpleNamespace(local_mode=True, max_download_duration_seconds=21600))
    return module.VideoDownloaderService()

@pytest.mark.parametrize('url', [
    f'https://kick.com/elzeein/videos/{VOD_ID}',
    f'https://www.kick.com/elzeein/videos/{VOD_ID}/?t=30&utm_source=x#top',
    f'http://kick.com/ElZeein/videos/{VOD_ID.upper()}',
    f'https://kick.com:443/elzeein/videos/{VOD_ID}',
])
def test_canonical_vod_urls(service, url):
    assert service.detect_source_type(url) == 'kick'
    assert module.kick_vod_url(url) == URL

@pytest.mark.parametrize('url', [
    'https://kick.com/elzeein',
    'https://kick.com/elzeein/videos',
    'https://kick.com/elzeein/clips/clip_01ABC',
    'https://kick.com/elzeein?clip=clip_01ABC',
    f'https://kick.com/video/{VOD_ID}',
    'https://kick.com/elzeein/videos/not-a-uuid',
    f'https://player.kick.com/elzeein/videos/{VOD_ID}',
    f'https://user:pass@kick.com/elzeein/videos/{VOD_ID}',
    f'https://kick.com:8443/elzeein/videos/{VOD_ID}',
])
def test_other_kick_pages_never_download_as_html(service, url):
    with pytest.raises(module.VideoDownloadError) as error:
        service.detect_source_type(url)
    assert safe_failure_code(error.value) == 'download.kick_unsupported'
    assert safe_processing_error(error.value) == 'Unsupported Kick source'

@pytest.mark.parametrize('url', [f'https://kick.com.evil.test/a/videos/{VOD_ID}', f'https://evilkick.com/a/videos/{VOD_ID}'])
def test_exact_host_matching(service, url):
    assert service.detect_source_type(url) == 'direct_url'

@pytest.mark.parametrize('info, reason', [
    ({'is_live': True, 'duration': None}, 'kick_not_completed'),
    ({'live_status': 'is_live', 'duration': 10}, 'kick_not_completed'),
    *[({'duration': value}, 'kick_duration') for value in [None, 0, -1, float('nan'), 21601]],
])
def test_metadata_rejection(service, info, reason):
    with pytest.raises(module.VideoDownloadError) as error:
        service._validate_vod_info(info, 21600, platform='kick')
    assert error.value.reason == reason
    assert safe_job_error_text(safe_processing_error(error.value)) == safe_processing_error(error.value)


def fake_download(monkeypatch, service, fail=None, extract_error=None):
    captured = []
    active = set()
    @contextmanager
    def guard(name):
        active.add(name)
        try:
            yield
        finally:
            active.remove(name)
    monkeypatch.setattr(module, 'guarded_public_connections', lambda: guard('network'))
    monkeypatch.setattr(module, 'guarded_ytdlp_children', lambda deadline: guard('children'))
    info = {'title': 'Saved stream', 'duration': 60, 'is_live': False, 'live_status': None, 'uploader': 'ElZeein'}
    class FakeYDL:
        def __init__(self, options):
            self.options = options
            captured.append(options)
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def extract_info(self, url, download=False):
            assert active == {'network', 'children'}
            assert url == URL
            if extract_error: raise extract_error
            return info
        def download(self, urls):
            assert active == {'network', 'children'}
            assert urls == [URL]
            self.options['match_filter'](info, incomplete=False)
            if fail: raise fail
            Path(self.options['outtmpl']).write_bytes(b'media')
    monkeypatch.setattr(module.yt_dlp, 'YoutubeDL', FakeYDL)
    probe = module.VideoMetadata('probe', 59, 1920, 1080, 60, 'probe', 'ffprobe')
    service._get_video_metadata_ffprobe = AsyncMock(return_value=probe)
    return captured


def test_download_uses_guarded_kick_extractor(service, monkeypatch, tmp_path):
    captured = fake_download(monkeypatch, service)
    result = asyncio.run(service.download_video(URL + '?t=20', str(tmp_path)))
    assert result.source_type == result.metadata.source_type == 'kick'
    assert (result.metadata.title, result.metadata.uploader) == ('Saved stream', 'ElZeein')
    for options in captured:
        assert options['allowed_extractors'] == ['kick:vod']
        assert options['proxy'] == ''
        assert options['external_downloader'] == 'native'
    assert captured[-1]['format'] == 'b[vcodec!^=av01]'
    assert captured[-1]['skip_unavailable_fragments'] is False


def test_missing_vod_is_unavailable(service, monkeypatch, tmp_path):
    fake_download(monkeypatch, service, extract_error=RuntimeError('HTTP Error 404: Not Found https://kick.com/api/v1/video/x'))
    with pytest.raises(module.VideoDownloadError) as error:
        asyncio.run(service.download_video(URL, str(tmp_path)))
    assert safe_processing_error(error.value) == 'Kick VOD unavailable'
    assert safe_failure_code(error.value) == 'download.kick_unavailable'


def test_provider_details_are_sanitized_and_partial_removed(service, monkeypatch, tmp_path):
    fake_download(monkeypatch, service, fail=RuntimeError('HTTP Error 403 https://secret.invalid/token'))
    with pytest.raises(module.VideoDownloadError) as error:
        asyncio.run(service.download_video(URL, str(tmp_path)))
    assert safe_processing_error(error.value) == 'Kick VOD unavailable'
    assert not list(tmp_path.iterdir())

// Point the main download button at the installer for the visitor's OS, using the latest GitHub release.
// Without JavaScript, or if the GitHub API is unavailable, every button still links to the Releases page.
(function () {
  const RELEASES = 'https://github.com/jwgung/doc-viewer/releases/latest';
  const API = 'https://api.github.com/repos/jwgung/doc-viewer/releases/latest';
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  // Phones and tablets get no desktop installer (iPhone browsers also send 'Mac OS X').
  const os = /Android|iPhone|iPad|iPod|Mobile/.test(ua) ? null
    : /win/i.test(platform) || /Windows/.test(ua) ? 'windows'
    : /mac/i.test(platform) || /Mac OS X/.test(ua) ? 'macos'
    : /linux/i.test(platform) && !/Android/.test(ua) ? 'linux'
    : null;

  // Which asset each button wants (matched against release asset names).
  const PATTERNS = {
    windows: /-windows-setup\.exe$/,
    'windows-msi': /-windows\.msi$/,
    macos: /-macos\.dmg$/,
    linux: /-linux-amd64\.deb$/,
    'linux-appimage': /-linux-amd64\.AppImage$/,
  };

  const main = document.querySelector('[data-download="auto"]');
  if (main && os) {
    const label = main.dataset['label' + os.charAt(0).toUpperCase() + os.slice(1)];
    if (label) main.querySelector('span').textContent = label;
    main.dataset.download = os;
  }

  fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
    .then((release) => {
      for (const el of document.querySelectorAll('[data-download]')) {
        const pattern = PATTERNS[el.dataset.download];
        const asset = pattern && release.assets.find((a) => pattern.test(a.name));
        if (asset) el.href = asset.browser_download_url;
      }
      for (const el of document.querySelectorAll('[data-version]')) el.textContent = release.tag_name;
    })
    .catch(() => {
      for (const el of document.querySelectorAll('[data-download]')) el.href = RELEASES;
    });
})();

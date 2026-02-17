importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');

const resolveCache = new Map();

const getCleanExt = (url) => {
    try {
        const urlObj = new URL(url, "http://example.com");
        const parts = urlObj.pathname.split('.');
        if (parts.length > 1) return parts.pop().toLowerCase();
    } catch (e) { }
    return url.split('.').pop().split('?')[0].split('#')[0].toLowerCase();
};

const resolveTrackFormats = async (url) => {
    if (resolveCache.has(url)) return resolveCache.get(url);
    const res = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
    const data = await res.json();
    resolveCache.set(url, data);
    return data;
};

const pickDirectUrl = (formats, qualityPref) => {
    const pref = qualityPref || 'best';
    const pick = (k) => formats?.[k] || null;
    if (pref === 'flac') return pick('flac');
    if (pref === 'mp3') return pick('mp3');
    if (pref === 'm4a') return pick('m4a') || pick('aac');
    return pick('flac') || pick('m4a') || pick('mp3') || pick('ogg') || formats?.directUrl || null;
};

const fetchToBlobDirect = async (directUrl, onProgress) => {
    const proxyUrl = `/api/download?url=${encodeURIComponent(directUrl)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const total = parseInt(res.headers.get('content-length') || '0', 10);
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(received, total);
    }

    return new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
};

const processTrack = async (item) => {
    try {
        self.postMessage({ id: item.id, status: 'progress', progress: 0, text: "Resolving..." });
        const formats = await resolveTrackFormats(item.track.url);
        const directUrl = pickDirectUrl(formats, item.qualityPref);

        if (!directUrl) throw new Error("No URL found for preferred quality");

        self.postMessage({ id: item.id, status: 'progress', progress: 10, text: "Downloading..." });

        const blob = await fetchToBlobDirect(directUrl, (down, total) => {
            const perc = total > 0 ? (down / total) * 100 : 50;
            self.postMessage({ id: item.id, status: 'progress', progress: perc, text: "Downloading..." });
        });

        let fileName = directUrl.split('/').pop();
        if (fileName) fileName = decodeURIComponent(fileName.split('?')[0]);
        if (!fileName) {
            const safeTitle = item.track.title.replace(/[^a-z0-9\s-]/gi, '').trim();
            const ext = getCleanExt(directUrl) || 'bin';
            fileName = `${item.track.number.toString().padStart(2, '0')} - ${safeTitle}.${ext}`;
        }

        self.postMessage({ id: item.id, status: 'complete', blob, fileName });
    } catch (e) {
        self.postMessage({ id: item.id, status: 'error', error: e.message });
    }
};

const processAlbum = async (item) => {
    try {
        const zip = new JSZip();
        const albumImages = Array.isArray(item?.meta?.albumImages)
            ? item.meta.albumImages.filter((imgUrl) => typeof imgUrl === 'string' && imgUrl.trim().length > 0)
            : [];
        const totalCovers = albumImages.length;

        if (totalCovers > 0) {
            let completedCovers = 0;
            const postCoverProgress = () => {
                self.postMessage({
                    id: item.id,
                    status: 'progress',
                    progress: 0,
                    text: `Downloading covers (${completedCovers}/${totalCovers})...`
                });
            };

            postCoverProgress();
            const coverPromises = albumImages.map(async (imgUrl) => {
                try {
                    const cRes = await fetch(`/api/image?url=${encodeURIComponent(imgUrl)}`);
                    if (cRes.ok) {
                        let fileName = imgUrl.split('/').pop();
                        if (fileName) {
                            fileName = decodeURIComponent(fileName.split('?')[0]);
                            zip.file(`Art/${fileName}`, await cRes.arrayBuffer());
                        }
                    }
                } catch (e) {
                } finally {
                    completedCovers += 1;
                    postCoverProgress();
                }
            });
            await Promise.all(coverPromises);
        }

        const totalTracks = item.tracks.length;
        const trackProgress = new Array(totalTracks).fill(0);
        let completedCount = 0;

        const updateProgress = () => {
            const totalPerc = trackProgress.reduce((a, b) => a + b, 0);
            const avg = totalPerc / totalTracks;
            self.postMessage({
                id: item.id,
                status: 'progress',
                progress: avg,
                text: `Downloading tracks (${completedCount}/${totalTracks})...`,
                trackProgressMap: trackProgress.reduce((acc, val, idx) => ({ ...acc, [idx]: val }), {})
            });
        };

        const poolLimit = 1;
        const executing = [];

        for (let i = 0; i < item.tracks.length; i++) {
            const track = item.tracks[i];
            const p = (async () => {
                try {
                    const formats = await resolveTrackFormats(track.url);
                    const directUrl = pickDirectUrl(formats, item.qualityPref);
                    if (!directUrl) throw new Error("No URL");

                    const blob = await fetchToBlobDirect(directUrl, (down, total) => {
                        trackProgress[i] = total > 0 ? (down / total) * 100 : 50;
                        updateProgress();
                    });

                    const data = await blob.arrayBuffer();
                    let fileName = directUrl.split('/').pop();
                    if (fileName) fileName = decodeURIComponent(fileName.split('?')[0]);
                    if (!fileName) {
                        const safeTitle = track.title.replace(/[^a-z0-9\s-]/gi, '').trim();
                        const ext = getCleanExt(directUrl) || 'bin';
                        fileName = `${track.number.toString().padStart(2, '0')} - ${safeTitle}.${ext}`;
                    }

                    zip.file(fileName, data);
                    trackProgress[i] = 100;
                    completedCount++;
                    updateProgress();
                } catch (e) {
                    console.warn(`Failed track ${track.title}`, e);
                    trackProgress[i] = 0;
                    completedCount++;
                }
            })();

            executing.push(p);
            const clean = () => executing.splice(executing.indexOf(p), 1);
            p.then(clean).catch(clean);

            if (executing.length >= poolLimit) {
                await Promise.race(executing);
            }
        }

        await Promise.all(executing);

        self.postMessage({ id: item.id, status: 'progress', progress: 99, text: "Compressing..." });

        const content = await zip.generateAsync({ type: "blob" }, (metadata) => {
            self.postMessage({
                id: item.id,
                status: 'progress',
                progress: 99,
                text: `Compressing ${metadata.percent.toFixed(0)}%`
            });
        });

        self.postMessage({
            id: item.id,
            status: 'complete',
            blob: content,
            fileName: `${item.meta.name}.zip`
        });

    } catch (e) {
        self.postMessage({ id: item.id, status: 'error', error: e.message });
    }
};

self.onmessage = (e) => {
    const item = e.data;
    if (item.type === 'album') {
        processAlbum(item);
    } else {
        processTrack(item);
    }
};

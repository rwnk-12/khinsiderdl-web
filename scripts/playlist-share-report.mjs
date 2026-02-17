import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_RELATIVE_SHARE_DIR = path.join('data', 'playlist-shares');

const toDataDir = () => {
    const configured = String(process.env.PLAYLIST_SHARE_DATA_DIR || '').trim();
    const root = configured || path.join(process.cwd(), DEFAULT_RELATIVE_SHARE_DIR);
    return path.resolve(root);
};

const fileExists = async (targetPath) => {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
};

const walkFiles = async (dirPath, collector = []) => {
    const exists = await fileExists(dirPath);
    if (!exists) return collector;

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            await walkFiles(fullPath, collector);
            continue;
        }
        if (entry.isFile()) {
            collector.push(fullPath);
        }
    }
    return collector;
};

const bytesToHuman = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
};

const getTotalSize = async (files) => {
    let total = 0;
    for (const file of files) {
        const stat = await fs.stat(file);
        total += stat.size;
    }
    return total;
};

const main = async () => {
    const dataDir = toDataDir();
    const linksDir = path.join(dataDir, 'links');
    const blobsDir = path.join(dataDir, 'blobs');

    const [linkFiles, blobFiles] = await Promise.all([
        walkFiles(linksDir),
        walkFiles(blobsDir),
    ]);

    const legacyFiles = (await walkFiles(dataDir)).filter((file) => {
        if (file.startsWith(linksDir) || file.startsWith(blobsDir)) return false;
        return file.toLowerCase().endsWith('.json');
    });

    const [linkBytes, blobBytes, legacyBytes] = await Promise.all([
        getTotalSize(linkFiles),
        getTotalSize(blobFiles),
        getTotalSize(legacyFiles),
    ]);

    const totalLinks = linkFiles.length;
    const totalBlobs = blobFiles.length;
    const dedupRatio = totalBlobs > 0 ? totalLinks / totalBlobs : 0;

    console.log('Playlist Share Storage Report');
    console.log('=============================');
    console.log(`Data dir: ${dataDir}`);
    console.log(`Links: ${totalLinks} (${bytesToHuman(linkBytes)})`);
    console.log(`Blobs: ${totalBlobs} (${bytesToHuman(blobBytes)})`);
    console.log(`Legacy files: ${legacyFiles.length} (${bytesToHuman(legacyBytes)})`);
    console.log(`Total size: ${bytesToHuman(linkBytes + blobBytes + legacyBytes)}`);
    console.log(`Dedup ratio (links/blobs): ${dedupRatio.toFixed(2)}`);
};

main().catch((error) => {
    console.error('Failed to build playlist share report:', error);
    process.exitCode = 1;
});
